import { HttpException, Inject, Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { PrismaService } from '../../database/prisma.service';
import { STATUS } from './domain/casamento';
import { canonico } from './domain/telefone';
import { idSeguro } from './domain/ids';
import {
  isWritableType,
  montarCampoCard,
  serializeFieldValue,
  valoresCampoEquivalentes,
} from './domain/campos';
import { comentarioSensivel, montarComentario } from './domain/comentario';
import {
  INCORPORATE_MESSAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  historicoSensivel,
  mimeDaOrigem,
  mimeDeFilename,
  mimePermitido,
  montarHistorico,
  nomeDaOrigem,
  sanitizarFilename,
  textoDaMensagem,
  urlDaMensagem,
  validarIncorporacao,
} from './domain/incorporacao';
import {
  criarOuRecuperarAtividade,
  type AtividadeKv,
} from './domain/criacao-atividade';
import { ClickUpInboxConfigService } from './clickup-inbox-config.service';
import { ClickUpInboxHttpClient } from './clickup-inbox-http.client';
import { ClickUpMatchService } from './clickup-match.service';
import { ClickUpCatalogService } from './clickup-catalog.service';
import { listaPrincipal } from './domain/perfil';
import {
  catalogoAtalhos,
  idsCatalogoAtalhos,
  idsCatalogoUniao,
  listsDoSpace,
  WORKBENCH_STATUS,
} from './domain/workbench';
import { extrairTaskRef } from './domain/task-ref';
import { CLICKUP_ATIVIDADE_KV, CLICKUP_W2_STORE } from './clickup-inbox.tokens';
import type { ClickUpW2Store } from './clickup-inbox-w2.store';
import {
  activitiesUnavailable,
  anchorConflict,
  conversationNotFound,
  invalidValue,
  mapUpstream,
  matchConflict,
  orgForbidden,
  isRedisFailure,
  storeUnavailable,
  taskNotBound,
} from './clickup-inbox.errors';

const IDEMPOTENCY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HTTPS = /^https:\/\//i;

@Injectable()
export class ClickUpInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ClickUpInboxConfigService,
    private readonly http: ClickUpInboxHttpClient,
    private readonly match: ClickUpMatchService,
    private readonly catalog: ClickUpCatalogService,
    @Inject(CLICKUP_ATIVIDADE_KV) private readonly atividadeKv: AtividadeKv,
    @Inject(CLICKUP_W2_STORE) private readonly w2Store: ClickUpW2Store,
  ) {}

  async resolve(organizationId: string, conversationId: string) {
    this.assertOrg(organizationId);
    const conv = await this.loadConversation(organizationId, conversationId);
    if (conv.isGroup) return { status: STATUS.GRUPO, conversationId: conv.id };

    const phoneResult = canonico(conv.contact.phone);
    if (!phoneResult.ok) {
      return {
        status: phoneResult.motivo === 'grupo' ? STATUS.GRUPO : STATUS.FORA_DO_PADRAO,
        motivo: phoneResult.motivo,
        conversationId: conv.id,
      };
    }

    await this.ensureRemote();
    try {
      const resolved = await this.match.resolverTelefone(organizationId, conv.contact.phone);
      if (resolved.status === STATUS.UNICO) {
        const card = await this.cardCompleto(resolved.taskId, conv.contact.phone);
        return {
          status: STATUS.UNICO,
          conversationId: conv.id,
          canonico: resolved.canonico,
          card,
        };
      }
      if (resolved.status === STATUS.AMBIGUO) {
        const candidatos = [];
        for (const taskId of resolved.taskIds) {
          candidatos.push(await this.candidatoMinimo(taskId));
        }
        return {
          status: STATUS.AMBIGUO,
          conversationId: conv.id,
          canonico: resolved.canonico,
          candidatos,
        };
      }
      return {
        status: resolved.status,
        conversationId: conv.id,
        canonico: 'canonico' in resolved ? resolved.canonico : undefined,
        motivo: 'motivo' in resolved ? resolved.motivo : undefined,
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  async getTask(organizationId: string, conversationId: string, taskId: string) {
    this.assertOrg(organizationId);
    const bound = await this.prepareBound(organizationId, conversationId, taskId);
    try {
      const card = await this.cardFromBound(bound, taskId);
      return { status: STATUS.UNICO, conversationId: bound.conv.id, card };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  async patchStatus(
    organizationId: string,
    conversationId: string,
    taskId: string,
    status: string,
  ) {
    this.assertOrg(organizationId);
    const bound = await this.prepareBound(organizationId, conversationId, taskId);
    try {
      const cardAntes = await this.cardFromBound(bound, taskId);
      if (!cardAntes.etapas.includes(status)) {
        invalidValue('status fora da lista permitida');
      }
      await this.http.write(`/task/${encodeURIComponent(taskId)}`, { status }, 'PUT');
      const card = await this.cardFromBound(bound, taskId);
      if (card.etapa !== status) {
        const erro = new Error('não foi possível confirmar o status por leitura') as Error & {
          status: number;
        };
        erro.status = 502;
        throw erro;
      }
      return { ok: true, etapa: card.etapa, card };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  async patchField(
    organizationId: string,
    conversationId: string,
    taskId: string,
    fieldId: string,
    value: unknown,
  ) {
    this.assertOrg(organizationId);
    if (!idSeguro(fieldId)) invalidValue('campo inválido');
    const bound = await this.prepareBound(organizationId, conversationId, taskId);
    const conv = bound.conv;
    const profile = this.config.profile();
    try {
      const task = await this.assertTaskForBound(bound, taskId);
      const onTask = (task.custom_fields ?? []).some((item: { id?: string }) => item.id === fieldId);
      if (!onTask) taskNotBound('campo ausente da task');
      const metadados = await this.http.camposDaLista(String(task.list?.id));
      const meta = metadados.find((item) => item.id === fieldId);
      if (!meta) taskNotBound('campo ausente dos metadados da lista');
      if (!isWritableType(meta.tipo) || profile.blockedFieldIds.includes(fieldId)) {
        invalidValue('campo bloqueado ou somente leitura');
      }
      const serialized = serializeFieldValue(meta.tipo, value, meta.opcoes);
      if (!serialized.ok) invalidValue(serialized.erro);
      await this.http.write(
        `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`,
        { value: serialized.value },
      );
      if (fieldId === profile.whatsappFieldId) {
        this.match.invalidate(organizationId);
      }
      const relido = await this.http.taskBruta(taskId);
      const persistido = (relido.custom_fields ?? []).find(
        (item: { id?: string }) => item.id === fieldId,
      )?.value;
      if (!valoresCampoEquivalentes(meta.tipo, persistido, serialized.value, meta.opcoes)) {
        const erro = new Error('não foi possível confirmar o campo por leitura') as Error & {
          status: number;
        };
        erro.status = 502;
        throw erro;
      }
      if (bound.kind === 'phone') {
        const stillBound = phonesMatch(conv.contact.phone, phoneFromTask(relido, profile.whatsappFieldId));
        if (!stillBound) {
          return {
            ok: true,
            valor: persistido ?? null,
            unbound: true,
            match: await this.resolve(organizationId, conversationId),
          };
        }
      }
      const card = await this.cardFromBound(bound, taskId);
      return { ok: true, valor: persistido ?? null, card };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  async postComment(
    organizationId: string,
    conversationId: string,
    taskId: string,
    userId: string,
    dto: { oQue: string; proximoPasso: string },
  ) {
    this.assertOrg(organizationId);
    const bound = await this.prepareBound(organizationId, conversationId, taskId);
    const conv = bound.conv;
    if (comentarioSensivel(dto)) invalidValue('o texto parece conter informação sensível');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const quem = user?.name || user?.email || 'operador';
    const texto = montarComentario({
      oQue: dto.oQue,
      quem,
      proximoPasso: dto.proximoPasso,
    });
    try {
      await this.cardFromBound(bound, taskId);
      const criado = await this.http.write(`/task/${encodeURIComponent(taskId)}/comment`, {
        comment_text: texto,
        notify_all: false,
      });
      const comentarios = await this.http.comentarios(taskId, 20);
      if (!comentarios.some((comentario) => String(comentario.id) === String(criado.id))) {
        const erro = new Error('não foi possível confirmar o comentário por leitura') as Error & {
          status: number;
        };
        erro.status = 502;
        throw erro;
      }
      return { ok: true, comentarioId: criado.id, comentarios };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  async postActivity(
    organizationId: string,
    conversationId: string,
    taskId: string,
    dto: { name: string; dueDate?: string },
  ) {
    this.assertOrg(organizationId);
    const bound = await this.prepareBound(organizationId, conversationId, taskId);
    const activities = this.config.profile().activities;
    if (!activities) activitiesUnavailable('atividades não estão configuradas');
    const dueDate = dto.dueDate ? new Date(`${dto.dueDate}T12:00:00-03:00`).getTime() : null;
    try {
      return await criarOuRecuperarAtividade({
        storage: this.atividadeKv,
        escopo: {
          organizationId,
          taskId,
          listaId: activities.listId,
          campoId: activities.relationFieldId,
          nome: dto.name.trim(),
          dueDate,
        },
        validar: async () => {
          await this.assertTaskForBound(bound, taskId);
          const destino = await this.validarDestinoAtividade(taskId);
          if (destino.listaId !== activities.listId || destino.campoId !== activities.relationFieldId) {
            activitiesUnavailable('destino de atividades mudou durante a validação');
          }
        },
        criar: () =>
          this.http.write(`/list/${encodeURIComponent(activities.listId)}/task`, {
            name: dto.name.trim(),
            due_date: dueDate,
            custom_fields: [{ id: activities.relationFieldId, value: { add: [taskId] } }],
          }),
        confirmar: async (atividadeId) => {
          await this.atividadePermitida(atividadeId, taskId);
          const card = await this.cardFromBound(bound, taskId);
          return { ok: true, atividadeId, card };
        },
        compensar: (atividadeId) => this.http.apagarTask(atividadeId),
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  async createTask(
    organizationId: string,
    conversationId: string,
    idempotencyKey: string,
    dto: { confirmSwitch?: boolean } = {},
  ) {
    this.assertOrg(organizationId);
    if (!IDEMPOTENCY_UUID.test(String(idempotencyKey ?? '').trim())) {
      invalidValue('Idempotency-Key inválida');
    }
    const key = String(idempotencyKey).trim();
    const conv = await this.loadConversation(organizationId, conversationId);
    if (conv.isGroup) invalidValue('grupo não cria card');
    const phone = canonico(conv.contact.phone);
    if (!phone.ok) invalidValue('telefone fora do padrão');
    const nome = String(conv.contact.name ?? '').trim();
    if (!nome) invalidValue('nomeie o contato antes de criar no ClickUp');

    await this.withStore(() => this.w2Store.assertReady());
    const token = await this.withStore(() =>
      this.w2Store.acquireLock(organizationId, phone.canonico),
    );

    try {
      const existing = await this.withStore(() =>
        this.w2Store.getReceipt(organizationId, phone.canonico, key),
      );
      if (existing?.state === 'done') {
        const relidoDone = await this.loadConversation(organizationId, conversationId);
        if (!relidoDone.clickupTaskId) {
          await this.ancorarConversacao(relidoDone, existing.taskId);
        }
        await this.ensureRemote();
        const card = await this.cardCompleto(existing.taskId, conv.contact.phone);
        return { ok: true, status: STATUS.UNICO, conversationId: conv.id, card };
      }

      const anchored = await this.loadConversation(organizationId, conversationId);
      if (anchored.clickupTaskId && dto.confirmSwitch !== true) {
        await this.ensureRemote();
        const card = await this.safeCard(anchored.clickupTaskId, idsCatalogoAtalhos(this.config.profile()));
        anchorConflict(card);
      }

      await this.ensureRemote();
      const rematch = await this.match.resolverTelefone(organizationId, conv.contact.phone, {
        force: true,
      });
      if (existing?.state === 'pending' && rematch.status === STATUS.UNICO) {
        await this.withStore(() =>
          this.w2Store.finalizeReceipt(organizationId, phone.canonico, key, rematch.taskId),
        );
        const relidoPending = await this.loadConversation(organizationId, conversationId);
        if (!relidoPending.clickupTaskId) {
          await this.ancorarConversacao(relidoPending, rematch.taskId);
        }
        const card = await this.cardCompleto(rematch.taskId, conv.contact.phone);
        return { ok: true, status: STATUS.UNICO, conversationId: conv.id, card };
      }
      if (rematch.status === STATUS.UNICO || rematch.status === STATUS.AMBIGUO) {
        matchConflict({ ...this.publicMatch(rematch, conv.id) });
      }
      if (rematch.status !== STATUS.SEM_CARD) invalidValue('não é possível criar neste estado');

      await this.withStore(() => this.w2Store.beginReceipt(organizationId, phone.canonico, key));

      const profile = this.config.profile();
      const listId = listaPrincipal(profile);
      const criado = await this.http.write(`/list/${encodeURIComponent(listId)}/task`, {
        name: nome,
        custom_fields: [{ id: profile.whatsappFieldId, value: phone.canonico }],
      });
      const taskId = String(criado?.id ?? '');
      if (!idSeguro(taskId)) {
        const erro = new Error('ClickUp não devolveu um id válido') as Error & { status: number };
        erro.status = 502;
        throw erro;
      }
      const relido = await this.http.taskBruta(taskId);
      if (String(relido.list?.id) !== listId) {
        await this.http.apagarTask(taskId).catch(() => undefined);
        const erro = new Error('task criada fora da lista principal') as Error & { status: number };
        erro.status = 502;
        throw erro;
      }
      const got = canonico(phoneFromTask(relido, profile.whatsappFieldId));
      if (!got.ok || got.canonico !== phone.canonico) {
        await this.http.apagarTask(taskId).catch(() => undefined);
        const erro = new Error('telefone da task criada não confere') as Error & { status: number };
        erro.status = 502;
        throw erro;
      }
      try {
        await this.withStore(() =>
          this.w2Store.finalizeReceipt(organizationId, phone.canonico, key, taskId),
        );
      } catch (err) {
        if (!isRedisFailure(err) && !(err instanceof HttpException && err.getStatus() === 503)) {
          throw err;
        }
        const removed = await this.http.apagarTask(taskId).then(() => true).catch(() => false);
        if (removed) {
          await this.w2Store.clearReceipt(organizationId, phone.canonico, key).catch(() => undefined);
        }
        storeUnavailable('não foi possível reter o comprovante da criação');
      }
      this.match.invalidate(organizationId);
      try {
        await this.ancorarConversacao(conv, taskId);
      } catch (err) {
        const removed = await this.http.apagarTask(taskId).then(() => true).catch(() => false);
        if (removed) {
          await this.w2Store.clearReceipt(organizationId, phone.canonico, key).catch(() => undefined);
        }
        throw err;
      }
      const card = await this.cardCompleto(taskId, conv.contact.phone);
      return { ok: true, status: STATUS.UNICO, conversationId: conv.id, card };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isRedisFailure(err)) storeUnavailable();
      mapUpstream(err);
    } finally {
      await this.w2Store.releaseLock(organizationId, phone.canonico, token).catch(() => undefined);
    }
  }

  async completeActivity(
    organizationId: string,
    conversationId: string,
    taskId: string,
    activityId: string,
  ) {
    this.assertOrg(organizationId);
    if (!idSeguro(activityId)) invalidValue('atividade inválida');
    const bound = await this.prepareBound(organizationId, conversationId, taskId);
    const activities = this.config.profile().activities;
    if (!activities) activitiesUnavailable('atividades não estão configuradas');
    try {
      const atividade = await this.atividadePermitida(activityId, taskId);
      const concluido = await this.http.statusConclusaoDaLista(String(atividade.list.id));
      await this.http.write(`/task/${encodeURIComponent(activityId)}`, { status: concluido }, 'PUT');
      const confirmacao = await this.atividadePermitida(activityId, taskId);
      if (confirmacao.status?.type !== 'closed' && confirmacao.status?.status !== concluido) {
        const erro = new Error(
          'não foi possível confirmar a conclusão da atividade por leitura',
        ) as Error & { status: number };
        erro.status = 502;
        throw erro;
      }
      const card = await this.cardFromBound(bound, taskId);
      return { ok: true, status: confirmacao.status?.status ?? concluido, card };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  private async withStore<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isRedisFailure(err)) storeUnavailable();
      throw err;
    }
  }

  assertOrg(organizationId: string) {
    const snap = this.config.snapshot();
    if (snap.ok && snap.organizationId !== organizationId) orgForbidden();
    if (!snap.ok) this.config.assertLocal();
  }

  private publicMatch(
    rematch: {
      status: string;
      canonico?: string;
      taskId?: string;
      taskIds?: string[];
    },
    conversationId: string,
  ) {
    return {
      status: rematch.status,
      conversationId,
      canonico: rematch.canonico,
      taskId: rematch.taskId,
      taskIds: rematch.taskIds,
    };
  }

  private async ensureRemote() {
    await this.config.ensureRemote(() => this.http.validateRemoteConfig());
  }

  private async prepareBound(organizationId: string, conversationId: string, taskId: string) {
    this.assertOrg(organizationId);
    if (!idSeguro(taskId)) invalidValue('task inválida');
    const conv = await this.loadConversation(organizationId, conversationId);
    if (conv.clickupTaskId === taskId) {
      await this.ensureRemote();
      await this.assertTaskOnAuthorizedLists(taskId, await this.authorizedListIds(organizationId));
      return { kind: 'conversation' as const, conv, organizationId };
    }
    if (conv.clickupTaskId) {
      taskNotBound('task não vinculada a esta conversa');
    }
    if (!conv.isGroup) {
      await this.ensureRemote();
      await this.assertTaskBound(taskId, conv.contact.phone);
      return { kind: 'phone' as const, conv, organizationId };
    }
    taskNotBound('task não vinculada a esta conversa');
  }

  async resolveWorkbench(organizationId: string, conversationId: string) {
    this.assertOrg(organizationId);
    const conv = await this.loadConversation(organizationId, conversationId);
    const project = await this.loadLinkedProject(organizationId, conversationId);
    await this.lazyBackfill(conv, project);
    const profile = this.config.profile();
    const catalogShortcuts = catalogoAtalhos(profile);
    const dossier = project ? this.publicProject(project) : null;
    const phone = conv.isGroup ? null : canonico(conv.contact.phone);
    const canCreateLead = Boolean(phone?.ok);
    const base = {
      conversationId: conv.id,
      catalogShortcuts,
      canCreateLead,
      dossier,
    };

    if (conv.clickupTaskId) {
      try {
        await this.ensureRemote();
        const card = await this.cardPorListas(
          conv.clickupTaskId,
          await this.authorizedListIds(organizationId),
        );
        return {
          ...base,
          status: WORKBENCH_STATUS.TASK_VINCULADA,
          card,
          phoneShortcut: await this.phoneShortcutIfAny(organizationId, conv),
        };
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() === 404) {
          return {
            ...base,
            status: WORKBENCH_STATUS.BINDING_INVALIDO,
            phoneShortcut: await this.phoneShortcutIfAny(organizationId, conv),
          };
        }
        if (err instanceof HttpException) throw err;
        mapUpstream(err);
      }
    }

    return {
      ...base,
      status: WORKBENCH_STATUS.SEM_VINCULO,
      phoneShortcut: await this.phoneShortcutIfAny(organizationId, conv),
    };
  }

  async catalogWorkbench(organizationId: string, conversationId: string) {
    this.assertOrg(organizationId);
    await this.loadConversation(organizationId, conversationId);
    const profile = this.config.profile();
    const catalogShortcuts = catalogoAtalhos(profile);
    if (profile.catalogSpaces.length === 0) {
      return { catalogShortcuts, spaces: [] as const };
    }
    await this.ensureRemote();
    try {
      const cache = await this.catalog.garantirArvore(organizationId);
      return { catalogShortcuts, spaces: cache.tree.spaces };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  async searchWorkbenchTasks(
    organizationId: string,
    conversationId: string,
    q: string,
    spaceId?: string,
  ) {
    this.assertOrg(organizationId);
    const conv = await this.loadConversation(organizationId, conversationId);
    const query = String(q ?? '').trim();
    if (!query) invalidValue('informe um id, URL ou termo de busca');
    const profile = this.config.profile();
    const space = String(spaceId ?? '').trim();
    if (space) {
      if (!profile.catalogSpaces.some((item) => item.id === space)) {
        invalidValue('space fora do catálogo autorizado');
      }
    }
    await this.ensureRemote();
    try {
      const allow = space
        ? new Set(listsDoSpace((await this.catalog.garantirArvore(organizationId)).tree, space))
        : idsCatalogoAtalhos(profile);
      const direto = pareceIdDeTask(query);
      if (direto) {
        try {
          const task = await this.http.taskBruta(direto);
          if (allow.has(String(task.list?.id))) {
            return { conversationId: conv.id, candidatos: [this.candidatoDeTask(task)] };
          }
        } catch (err) {
          if (!isTaskMissing(err)) throw err;
        }
      }
      const encontrados = await this.http.buscarNasListas([...allow], query);
      return {
        conversationId: conv.id,
        candidatos: encontrados.map((task) => this.candidatoDeTask(task)),
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  async bindWorkbenchTask(
    organizationId: string,
    conversationId: string,
    idempotencyKey: string,
    dto: { taskRef: string; crossLinkDossier?: boolean; confirmSwitch?: boolean },
  ) {
    this.assertOrg(organizationId);
    if (!IDEMPOTENCY_UUID.test(String(idempotencyKey ?? '').trim())) {
      invalidValue('Idempotency-Key inválida');
    }
    const key = String(idempotencyKey).trim();
    const conv = await this.loadConversation(organizationId, conversationId);
    const taskId = extrairTaskRef(dto.taskRef);
    if (!taskId) invalidValue('referência de task inválida');
    const project = await this.loadLinkedProject(organizationId, conversationId);

    if (conv.clickupTaskId === taskId) {
      await this.ensureRemote();
      const allow = await this.authorizedListIds(organizationId);
      const card = await this.cardPorListas(taskId, allow);
      return { ok: true, status: WORKBENCH_STATUS.TASK_VINCULADA, conversationId: conv.id, card };
    }
    if (conv.clickupTaskId && dto.confirmSwitch !== true) {
      await this.ensureRemote();
      const allow = await this.authorizedListIds(organizationId);
      const card = await this.safeCard(conv.clickupTaskId, allow);
      anchorConflict(card);
    }

    const scope = `conv:${conv.id}`;
    await this.withStore(() => this.w2Store.assertReady());
    const token = await this.withStore(() => this.w2Store.acquireLock(organizationId, scope));
    try {
      const existing = await this.withStore(() => this.w2Store.getReceipt(organizationId, scope, key));
      const relido = await this.loadConversation(organizationId, conversationId);
      if (existing?.state === 'done') {
        if (!relido.clickupTaskId) {
          await this.ancorarConversacao(relido, existing.taskId);
        }
        await this.ensureRemote();
        const allow = await this.authorizedListIds(organizationId);
        const card = await this.cardPorListas(existing.taskId, allow);
        return { ok: true, status: WORKBENCH_STATUS.TASK_VINCULADA, conversationId: conv.id, card };
      }
      if (relido.clickupTaskId && relido.clickupTaskId !== taskId && dto.confirmSwitch !== true) {
        await this.ensureRemote();
        const allow = await this.authorizedListIds(organizationId);
        const card = await this.safeCard(relido.clickupTaskId, allow);
        anchorConflict(card);
      }
      await this.ensureRemote();
      const allow = await this.authorizedListIds(organizationId);
      await this.assertTaskOnAuthorizedLists(taskId, allow);
      await this.withStore(() => this.w2Store.beginReceipt(organizationId, scope, key));
      await this.ancorarConversacao(relido, taskId);
      await this.maybeCrossLink(project, taskId, dto.crossLinkDossier);
      await this.withStore(() => this.w2Store.finalizeReceipt(organizationId, scope, key, taskId));
      const card = await this.cardPorListas(taskId, allow);
      return { ok: true, status: WORKBENCH_STATUS.TASK_VINCULADA, conversationId: conv.id, card };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isRedisFailure(err)) storeUnavailable();
      mapUpstream(err);
    } finally {
      await this.w2Store.releaseLock(organizationId, scope, token).catch(() => undefined);
    }
  }

  async createWorkbenchTask(
    organizationId: string,
    conversationId: string,
    idempotencyKey: string,
    dto: { listId: string; name: string; crossLinkDossier?: boolean; confirmSwitch?: boolean },
  ) {
    this.assertOrg(organizationId);
    if (!IDEMPOTENCY_UUID.test(String(idempotencyKey ?? '').trim())) {
      invalidValue('Idempotency-Key inválida');
    }
    const key = String(idempotencyKey).trim();
    const conv = await this.loadConversation(organizationId, conversationId);
    const listId = String(dto.listId ?? '').trim();
    const name = String(dto.name ?? '').trim();
    if (!name) invalidValue('nome da task é obrigatório');
    if (!idSeguro(listId)) invalidValue('lista fora do catálogo autorizado');
    const shortcuts = idsCatalogoAtalhos(this.config.profile());
    if (!shortcuts.has(listId)) {
      if (this.config.profile().catalogSpaces.length === 0) {
        invalidValue('lista fora do catálogo autorizado');
      }
      await this.ensureRemote();
      const allow = await this.authorizedListIds(organizationId);
      if (!allow.has(listId)) invalidValue('lista fora do catálogo autorizado');
    }

    const project = await this.loadLinkedProject(organizationId, conversationId);

    const scope = `conv:${conv.id}`;
    await this.withStore(() => this.w2Store.assertReady());
    const token = await this.withStore(() => this.w2Store.acquireLock(organizationId, scope));

    try {
      const existing = await this.withStore(() => this.w2Store.getReceipt(organizationId, scope, key));
      const relido = await this.loadConversation(organizationId, conversationId);
      if (existing?.state === 'done') {
        if (!relido.clickupTaskId) {
          await this.ancorarConversacao(relido, existing.taskId);
        }
        await this.ensureRemote();
        const allow = await this.authorizedListIds(organizationId);
        const card = await this.cardPorListas(existing.taskId, allow);
        return { ok: true, status: WORKBENCH_STATUS.TASK_VINCULADA, conversationId: conv.id, card };
      }
      if (relido.clickupTaskId && dto.confirmSwitch !== true) {
        await this.ensureRemote();
        const allow = await this.authorizedListIds(organizationId);
        const card = await this.safeCard(relido.clickupTaskId, allow);
        anchorConflict(card);
      }

      await this.ensureRemote();
      const allow = await this.authorizedListIds(organizationId);
      if (!allow.has(listId)) invalidValue('lista fora do catálogo autorizado');
      await this.withStore(() => this.w2Store.beginReceipt(organizationId, scope, key));
      const criado = await this.http.write(`/list/${encodeURIComponent(listId)}/task`, { name });
      const taskId = String(criado?.id ?? '');
      if (!idSeguro(taskId)) {
        const erro = new Error('ClickUp não devolveu um id válido') as Error & { status: number };
        erro.status = 502;
        throw erro;
      }
      const bruta = await this.http.taskBruta(taskId);
      if (String(bruta.list?.id) !== listId || !allow.has(String(bruta.list?.id))) {
        await this.http.apagarTask(taskId).catch(() => undefined);
        const erro = new Error('task criada fora da lista escolhida') as Error & { status: number };
        erro.status = 502;
        throw erro;
      }
      try {
        await this.withStore(() => this.w2Store.finalizeReceipt(organizationId, scope, key, taskId));
      } catch (err) {
        if (!isRedisFailure(err) && !(err instanceof HttpException && err.getStatus() === 503)) {
          throw err;
        }
        const removed = await this.http.apagarTask(taskId).then(() => true).catch(() => false);
        if (removed) {
          await this.w2Store.clearReceipt(organizationId, scope, key).catch(() => undefined);
        }
        storeUnavailable('não foi possível reter o comprovante da criação');
      }
      try {
        await this.ancorarConversacao(relido, taskId);
      } catch (err) {
        const removed = await this.http.apagarTask(taskId).then(() => true).catch(() => false);
        if (removed) {
          await this.w2Store.clearReceipt(organizationId, scope, key).catch(() => undefined);
        }
        throw err;
      }
      await this.maybeCrossLink(project, taskId, dto.crossLinkDossier);
      const card = await this.cardPorListas(taskId, allow);
      return { ok: true, status: WORKBENCH_STATUS.TASK_VINCULADA, conversationId: conv.id, card };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isRedisFailure(err)) storeUnavailable();
      mapUpstream(err);
    } finally {
      await this.w2Store.releaseLock(organizationId, scope, token).catch(() => undefined);
    }
  }

  async incorporateWorkbench(
    organizationId: string,
    conversationId: string,
    idempotencyKey: string,
    dto: { kind?: string; messageId?: string; documentId?: string },
  ) {
    this.assertOrg(organizationId);
    if (!IDEMPOTENCY_UUID.test(String(idempotencyKey ?? '').trim())) {
      invalidValue('Idempotency-Key inválida');
    }
    const key = String(idempotencyKey).trim();
    const parsed = validarIncorporacao(dto);
    if (!parsed.ok) invalidValue(parsed.erro);
    const conv = await this.loadConversation(organizationId, conversationId);
    if (!conv.clickupTaskId) taskNotBound('task não vinculada a esta conversa');
    const taskId = conv.clickupTaskId;
    const originId = parsed.value.messageId ?? parsed.value.documentId!;
    const scope = `conv:${conv.id}:w3:${parsed.value.kind}:${originId}`;

    await this.withStore(() => this.w2Store.assertReady());
    const token = await this.withStore(() => this.w2Store.acquireLock(organizationId, scope));
    try {
      const existing = await this.withStore(() => this.w2Store.getReceipt(organizationId, scope, key));
      if (existing?.state === 'done') {
        return { ok: true, kind: parsed.value.kind, id: existing.taskId };
      }
      await this.ensureRemote();
      await this.assertTaskOnAuthorizedLists(taskId, await this.authorizedListIds(organizationId));

      if (parsed.value.kind === 'comment') {
        return await this.incorporateComment(
          organizationId,
          conversationId,
          scope,
          key,
          taskId,
          parsed.value.messageId!,
        );
      }
      return await this.incorporateAttachment(
        organizationId,
        conversationId,
        scope,
        key,
        taskId,
        parsed.value,
      );
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isRedisFailure(err)) storeUnavailable();
      mapUpstream(err);
    } finally {
      await this.w2Store.releaseLock(organizationId, scope, token).catch(() => undefined);
    }
  }

  async incorporateGroup(
    organizationId: string,
    conversationId: string,
    idempotencyKey: string,
    dto: { kind?: string; messageId?: string; documentId?: string },
  ) {
    this.assertOrg(organizationId);
    const conv = await this.loadConversation(organizationId, conversationId);
    if (!conv.isGroup) invalidValue('esta rota é só para conversas em grupo');
    return this.incorporateWorkbench(organizationId, conversationId, idempotencyKey, dto);
  }

  async resolveGroup(organizationId: string, conversationId: string) {
    this.assertOrg(organizationId);
    const conv = await this.loadConversation(organizationId, conversationId);
    if (!conv.isGroup) invalidValue('esta rota é só para conversas em grupo');
    return this.resolveWorkbench(organizationId, conversationId);
  }

  async searchGroupTasks(organizationId: string, conversationId: string, q: string) {
    this.assertOrg(organizationId);
    const conv = await this.loadConversation(organizationId, conversationId);
    if (!conv.isGroup) invalidValue('esta rota é só para conversas em grupo');
    return this.searchWorkbenchTasks(organizationId, conversationId, q);
  }

  async bindGroupTask(
    organizationId: string,
    conversationId: string,
    taskRef: string,
    idempotencyKey: string,
  ) {
    this.assertOrg(organizationId);
    const conv = await this.loadConversation(organizationId, conversationId);
    if (!conv.isGroup) invalidValue('esta rota é só para conversas em grupo');
    return this.bindWorkbenchTask(organizationId, conversationId, idempotencyKey, { taskRef });
  }

  async createGroupTask(
    organizationId: string,
    conversationId: string,
    idempotencyKey: string,
    dto: { listId: string; name: string; crossLinkDossier?: boolean; confirmSwitch?: boolean },
  ) {
    this.assertOrg(organizationId);
    const conv = await this.loadConversation(organizationId, conversationId);
    if (!conv.isGroup) invalidValue('esta rota é só para conversas em grupo');
    return this.createWorkbenchTask(organizationId, conversationId, idempotencyKey, dto);
  }

  private async incorporateComment(
    organizationId: string,
    conversationId: string,
    scope: string,
    key: string,
    taskId: string,
    messageId: string,
  ) {
    const message = await this.loadOriginMessage(organizationId, conversationId, messageId);
    if (!INCORPORATE_MESSAGE_TYPES.has(String(message.type))) {
      invalidValue('tipo de mensagem incompatível com comentário');
    }
    const texto = textoDaMensagem(message.content);
    if (!texto) invalidValue('mensagem sem texto para incorporar');
    if (historicoSensivel(texto)) invalidValue('o texto parece conter informação sensível');
    const bloco = montarHistorico({
      quando: message.providerTimestamp ?? message.createdAt ?? new Date(),
      senderName: message.senderName,
      direcao: message.direction,
      texto,
    });
    await this.withStore(() => this.w2Store.beginReceipt(organizationId, scope, key));
    const ja = await this.http.comentarios(taskId, 40);
    const existente = ja.find((comentario) => String(comentario.texto ?? '').includes(texto.slice(0, 80)));
    if (existente?.id) {
      await this.withStore(() => this.w2Store.finalizeReceipt(organizationId, scope, key, String(existente.id)));
      return { ok: true, kind: 'comment' as const, id: String(existente.id) };
    }
    const criado = await this.http.write(`/task/${encodeURIComponent(taskId)}/comment`, {
      comment_text: bloco,
      notify_all: false,
    });
    const id = String(criado?.id ?? '');
    const comentarios = await this.http.comentarios(taskId, 40);
    if (!id || !comentarios.some((comentario) => String(comentario.id) === id)) {
      const erro = new Error('não foi possível confirmar o comentário por leitura') as Error & {
        status: number;
      };
      erro.status = 502;
      throw erro;
    }
    await this.withStore(() => this.w2Store.finalizeReceipt(organizationId, scope, key, id));
    return { ok: true, kind: 'comment' as const, id };
  }

  private async incorporateAttachment(
    organizationId: string,
    conversationId: string,
    scope: string,
    key: string,
    taskId: string,
    parsed: { messageId?: string; documentId?: string },
  ) {
    const origin = parsed.messageId
      ? await this.originFromMessage(organizationId, conversationId, parsed.messageId)
      : await this.originFromDocument(organizationId, conversationId, parsed.documentId!);
    if (!mimePermitido(origin.mime, origin.filename)) {
      invalidValue('tipo de arquivo não permitido');
    }
    if (origin.declaredSize != null && origin.declaredSize > MAX_ATTACHMENT_BYTES) {
      invalidValue('anexo excede 25 MiB');
    }
    const bytes = await this.lerBytesOrigem(origin.url, origin.inline);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) invalidValue('anexo excede 25 MiB');
    await this.withStore(() => this.w2Store.beginReceipt(organizationId, scope, key));
    const task = await this.http.taskBruta(taskId);
    const ja = Array.isArray(task?.attachments) ? task.attachments : [];
    const match = ja.find(
      (item: { id?: string; title?: string; name?: string }) =>
        sanitizarFilename(String(item.title ?? item.name ?? '')) === origin.filename,
    );
    if (match?.id) {
      await this.withStore(() => this.w2Store.finalizeReceipt(organizationId, scope, key, String(match.id)));
      return { ok: true, kind: 'attachment' as const, id: String(match.id) };
    }
    const criado = await this.http.uploadAttachment(taskId, {
      filename: origin.filename,
      mime: origin.mime,
      bytes,
    });
    const id = String(criado?.id ?? '');
    const relido = await this.http.taskBruta(taskId);
    const attachments = Array.isArray(relido?.attachments) ? relido.attachments : [];
    if (!id || !attachments.some((item: { id?: string }) => String(item.id) === id)) {
      const erro = new Error('não foi possível confirmar o anexo por leitura') as Error & {
        status: number;
      };
      erro.status = 502;
      throw erro;
    }
    await this.withStore(() => this.w2Store.finalizeReceipt(organizationId, scope, key, id));
    return { ok: true, kind: 'attachment' as const, id };
  }

  private async loadOriginMessage(organizationId: string, conversationId: string, messageId: string) {
    if (!idSeguro(messageId)) invalidValue('messageId inválido');
    const message = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        revokedAt: null,
        conversation: { organizationId, deletedAt: null },
      },
      select: {
        id: true,
        conversationId: true,
        type: true,
        content: true,
        senderName: true,
        direction: true,
        providerTimestamp: true,
        createdAt: true,
      },
    });
    if (!message) invalidValue('mensagem não encontrada nesta conversa');
    return message;
  }

  private async originFromMessage(organizationId: string, conversationId: string, messageId: string) {
    const message = await this.loadOriginMessage(organizationId, conversationId, messageId);
    if (!INCORPORATE_MESSAGE_TYPES.has(String(message.type))) {
      invalidValue('tipo de mensagem incompatível com anexo');
    }
    const url = urlDaMensagem(message.content);
    if (!url) invalidValue('mensagem sem arquivo para anexar');
    const filename = sanitizarFilename(nomeDaOrigem(message.content));
    const mime = mimeDaOrigem(message.content) || mimeDeFilename(filename) || '';
    const declared = Number((message.content as { size?: unknown })?.size);
    return {
      url,
      filename,
      mime,
      declaredSize: Number.isFinite(declared) ? declared : null,
      inline: null as Buffer | null,
    };
  }

  private async originFromDocument(organizationId: string, conversationId: string, documentId: string) {
    if (!idSeguro(documentId)) invalidValue('documentId inválido');
    const attachment = await this.prisma.projectAttachment.findFirst({
      where: {
        id: documentId,
        project: {
          organizationId,
          deletedAt: null,
          conversations: { some: { conversationId } },
        },
      },
      select: { id: true, url: true, fileName: true, mimeType: true, label: true },
    });
    if (!attachment?.url) invalidValue('documento não encontrado neste dossiê');
    const filename = sanitizarFilename(attachment.fileName || attachment.label || 'anexo');
    const mime = (attachment.mimeType || mimeDeFilename(filename) || '').toLowerCase();
    return { url: attachment.url, filename, mime, declaredSize: null as number | null, inline: null as Buffer | null };
  }

  private async lerBytesOrigem(url: string, inline: Buffer | null): Promise<Buffer> {
    if (inline) return inline;
    const local = this.localUploadPath(url);
    if (local) {
      try {
        const bytes = await readFile(local);
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) invalidValue('anexo excede 25 MiB');
        return bytes;
      } catch (err) {
        if (err instanceof HttpException) throw err;
        invalidValue('não foi possível ler o arquivo local');
      }
    }
    if (!HTTPS.test(url) && !url.startsWith('http://files.test/') && !url.startsWith('https://files.test/')) {
      invalidValue('URL de anexo inválida');
    }
    try {
      const { bytes } = await this.http.fetchMediaBytes(url, MAX_ATTACHMENT_BYTES);
      return bytes;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      const status = (err as { status?: number })?.status;
      if (status === 422) invalidValue((err as Error).message || 'anexo inválido');
      throw err;
    }
  }

  private localUploadPath(url: string): string | null {
    let pathname = url;
    try {
      if (/^https?:\/\//i.test(url)) pathname = new URL(url).pathname;
    } catch {
      return null;
    }
    const marker = pathname.includes('/api/v1/uploads/')
      ? '/api/v1/uploads/'
      : pathname.startsWith('/uploads/')
        ? '/uploads/'
        : null;
    if (!marker) return null;
    const rel = pathname.slice(pathname.indexOf(marker) + marker.length);
    if (!rel || rel.includes('..')) return null;
    const root = resolvePath(process.env.UPLOADS_DIR || join(process.cwd(), 'uploads'));
    const abs = resolvePath(join(root, rel));
    if (!abs.startsWith(root)) return null;
    return abs;
  }

  private publicProject(project: { id: string; name: string; clickupTaskId: string | null }) {
    return {
      id: project.id,
      name: project.name,
      clickupTaskId: project.clickupTaskId,
    };
  }

  private async loadLinkedProject(organizationId: string, conversationId: string) {
    const link = await this.prisma.projectConversation.findFirst({
      where: {
        conversationId,
        project: { organizationId, deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        project: {
          select: { id: true, name: true, clickupTaskId: true, organizationId: true },
        },
      },
    });
    return link?.project ?? null;
  }

  private async ancorarDossie(
    project: { id: string; organizationId: string; clickupTaskId?: string | null },
    taskId: string,
  ) {
    await this.prisma.project.update({
      where: { id: project.id },
      data: { clickupTaskId: taskId },
    });
    project.clickupTaskId = taskId;
  }

  private async ancorarConversacao(
    conv: { id: string; clickupTaskId: string | null },
    taskId: string,
  ) {
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: { clickupTaskId: taskId },
    });
    conv.clickupTaskId = taskId;
  }

  private async lazyBackfill(
    conv: { id: string; clickupTaskId: string | null },
    project: { id: string; organizationId: string; clickupTaskId: string | null } | null,
  ) {
    if (conv.clickupTaskId || !project?.clickupTaskId) return;
    const siblings = await this.prisma.projectConversation.findMany({
      where: {
        projectId: project.id,
        conversation: { deletedAt: null },
      },
      select: { conversationId: true },
    });
    if (siblings.length !== 1 || siblings[0]?.conversationId !== conv.id) return;
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: { clickupTaskId: project.clickupTaskId },
    });
    conv.clickupTaskId = project.clickupTaskId;
  }

  private async maybeCrossLink(
    project: { id: string; organizationId: string; clickupTaskId: string | null } | null,
    taskId: string,
    explicit?: boolean,
  ) {
    if (!project) return;
    const should =
      explicit === true ? true : explicit === false ? false : !project.clickupTaskId;
    if (!should) return;
    if (project.clickupTaskId === taskId) return;
    if (project.clickupTaskId && explicit !== true) return;
    try {
      await this.ancorarDossie(project, taskId);
    } catch {
      /* cruzamento é best-effort; não desfaz o bind da conversa */
    }
  }

  private async phoneShortcutIfAny(
    organizationId: string,
    conv: { id: string; isGroup: boolean; contact: { name: string | null; phone: string | null } },
  ) {
    if (conv.isGroup) return undefined;
    const phoneResult = canonico(conv.contact.phone);
    if (!phoneResult.ok) {
      return {
        status: phoneResult.motivo === 'grupo' ? STATUS.GRUPO : STATUS.FORA_DO_PADRAO,
        motivo: phoneResult.motivo,
      };
    }
    await this.ensureRemote();
    try {
      const resolved = await this.match.resolverTelefone(organizationId, conv.contact.phone);
      const primary = this.config.profile().lists.find((lista) => lista.primary);
      if (resolved.status === STATUS.UNICO) {
        const card = await this.cardCompleto(resolved.taskId, conv.contact.phone);
        return {
          status: STATUS.UNICO,
          canonico: resolved.canonico,
          card,
          primaryListLabel: primary?.label ?? null,
        };
      }
      if (resolved.status === STATUS.AMBIGUO) {
        const candidatos = [];
        for (const taskId of resolved.taskIds) {
          candidatos.push(await this.candidatoMinimo(taskId));
        }
        return {
          status: STATUS.AMBIGUO,
          canonico: resolved.canonico,
          candidatos,
          primaryListLabel: primary?.label ?? null,
        };
      }
      return {
        status: resolved.status,
        canonico: 'canonico' in resolved ? resolved.canonico : undefined,
        motivo: 'motivo' in resolved ? resolved.motivo : undefined,
        primaryListLabel: primary?.label ?? null,
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  private async safeCard(taskId: string, allow: Set<string>) {
    try {
      return await this.cardPorListas(taskId, allow);
    } catch {
      return null;
    }
  }

  private async assertTaskOnAuthorizedLists(taskId: string, allow: Set<string>) {
    let task: any;
    try {
      task = await this.http.taskBruta(taskId);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
    if (!task?.id || !allow.has(String(task.list?.id))) {
      taskNotBound('task fora das listas autorizadas');
    }
    return task;
  }

  private async authorizedListIds(organizationId: string): Promise<Set<string>> {
    const profile = this.config.profile();
    const shortcuts = idsCatalogoAtalhos(profile);
    if (profile.catalogSpaces.length === 0) return shortcuts;
    try {
      const cache = await this.catalog.garantirArvore(organizationId);
      return idsCatalogoUniao(profile, cache.tree);
    } catch {
      return shortcuts;
    }
  }

  private async assertTaskForBound(
    bound: Awaited<ReturnType<ClickUpInboxService['prepareBound']>>,
    taskId: string,
  ) {
    if (bound.kind === 'conversation') {
      return this.assertTaskOnAuthorizedLists(taskId, await this.authorizedListIds(bound.organizationId));
    }
    return this.assertTaskBound(taskId, bound.conv.contact.phone);
  }

  private async cardFromBound(
    bound: Awaited<ReturnType<ClickUpInboxService['prepareBound']>>,
    taskId: string,
  ) {
    if (bound.kind === 'conversation') {
      return this.cardPorListas(taskId, await this.authorizedListIds(bound.organizationId));
    }
    return this.cardCompleto(taskId, bound.conv.contact.phone);
  }

  private async cardPorListas(taskId: string, allow: Set<string>) {
    const profile = this.config.profile();
    const blocked = new Set(profile.blockedFieldIds);
    const task = await this.assertTaskOnAuthorizedLists(taskId, allow);
    return this.montarCard(task, blocked);
  }

  private candidatoDeTask(task: any) {
    return {
      taskId: String(task.id),
      nome: String(task.name ?? ''),
      status: task.status?.status ?? null,
      lista: task.list?.name ?? null,
    };
  }

  private async loadConversation(organizationId: string, conversationId: string) {
    if (!idSeguro(conversationId)) conversationNotFound();
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, deletedAt: null },
      select: {
        id: true,
        isGroup: true,
        clickupTaskId: true,
        contact: { select: { name: true, phone: true } },
      },
    });
    if (!conv) conversationNotFound();
    return conv;
  }

  private async assertTaskBound(taskId: string, conversationPhone: string | null) {
    const profile = this.config.profile();
    let task: any;
    try {
      task = await this.http.taskBruta(taskId);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
    const listas = new Set(profile.lists.map((lista) => lista.id));
    if (!task?.id || !listas.has(String(task.list?.id))) {
      taskNotBound('task fora das listas permitidas pelo perfil');
    }
    const expected = canonico(conversationPhone);
    const got = canonico(phoneFromTask(task, profile.whatsappFieldId));
    if (!expected.ok || !got.ok || expected.canonico !== got.canonico) {
      taskNotBound('telefone da task não coincide com a conversa');
    }
    return task;
  }

  private async candidatoMinimo(taskId: string) {
    const task = await this.http.taskBruta(taskId);
    return {
      taskId: String(task.id),
      nome: String(task.name ?? ''),
      status: task.status?.status ?? null,
      lista: task.list?.name ?? null,
    };
  }

  private async cardCompleto(taskId: string, conversationPhone: string | null) {
    const profile = this.config.profile();
    const blocked = new Set(profile.blockedFieldIds);
    const task = await this.assertTaskBound(taskId, conversationPhone);
    return this.montarCard(task, blocked);
  }

  private async montarCard(task: any, blocked: Set<string>) {
    const listId = String(task.list?.id);
    const [metadados, lista, atividades, comentarios] = await Promise.all([
      this.http.camposDaLista(listId),
      this.http.get(`/list/${encodeURIComponent(listId)}`),
      this.atividadesDoCard(task.id),
      this.http.comentarios(task.id, 8),
    ]);
    const valores = new Map(
      (task.custom_fields ?? []).map((campo: { id: string; value: unknown }) => [campo.id, campo.value]),
    );
    const presentes = new Set(
      (task.custom_fields ?? []).map((campo: { id: string }) => campo.id),
    );
    const campos = metadados.map((campo) =>
      montarCampoCard(campo, valores.get(campo.id) ?? null, blocked, presentes.has(campo.id)),
    );
    const url = typeof task.url === 'string' && HTTPS.test(task.url) ? task.url : null;
    return {
      taskId: String(task.id),
      nome: String(task.name ?? ''),
      etapa: task.status?.status ?? null,
      etapas: (lista.statuses ?? []).map((status: { status: string }) => status.status),
      url,
      lista: task.list?.name ?? null,
      listId,
      campos,
      atividades: atividades.itens,
      atividadesHabilitadas: atividades.habilitadas,
      comentarios,
    };
  }

  private async atividadesDoCard(taskId: string) {
    const activities = this.config.profile().activities;
    if (!activities) return { habilitadas: false, itens: [] as any[] };
    const tarefas = await this.http.tarefasDaLista(activities.listId);
    const itens = tarefas
      .filter((task: any) => {
        const campo = (task.custom_fields ?? []).find(
          (item: { id?: string }) => item.id === activities.relationFieldId,
        );
        return idsRelacionados(campo?.value).includes(String(taskId));
      })
      .filter((task: any) => task.status?.type !== 'closed')
      .map((task: any) => ({
        id: String(task.id),
        nome: String(task.name ?? ''),
        status: task.status?.status ?? null,
      }));
    return { habilitadas: true, itens };
  }

  private async validarDestinoAtividade(taskId: string) {
    const activities = this.config.profile().activities;
    if (!activities) activitiesUnavailable('destino de atividades não configurado');
    const task = await this.http.taskBruta(taskId);
    const { campo } = await this.http.validarRelacaoAtividade(activities);
    const listaRelacionada =
      campo.type_config?.subcategory_id
      ?? campo.type_config?.list_id
      ?? campo.type_config?.related_list_id;
    if (listaRelacionada != null && String(listaRelacionada) !== String(task.list?.id)) {
      activitiesUnavailable('campo de relacionamento aponta para uma lista diferente da task autorizada');
    }
    return { listaId: activities.listId, campoId: activities.relationFieldId };
  }

  private async atividadePermitida(atividadeId: string, taskId: string) {
    const activities = this.config.profile().activities;
    if (!activities) activitiesUnavailable('atividades não estão configuradas');
    const atividade = await this.http.taskBruta(atividadeId);
    if (String(atividade.list?.id) !== activities.listId) {
      taskNotBound('atividade fora da lista permitida');
    }
    const relacao = (atividade.custom_fields ?? []).find(
      (campo: { id?: string }) => campo.id === activities.relationFieldId,
    )?.value;
    if (!idsRelacionados(relacao).includes(String(taskId))) {
      taskNotBound('atividade não está vinculada ao card autorizado');
    }
    return atividade;
  }
}

function pareceIdDeTask(query: string): string | null {
  const id = extrairTaskRef(query);
  if (!id) return null;
  if (/^https:\/\//i.test(query.trim())) return id;
  return /\d/.test(id) ? id : null;
}

function isTaskMissing(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 404) return true;
  return err instanceof HttpException && err.getStatus() === 404;
}

function phoneFromTask(task: any, whatsappFieldId: string): unknown {
  return (task.custom_fields ?? []).find((campo: { id?: string }) => campo.id === whatsappFieldId)
    ?.value ?? null;
}

function phonesMatch(conversationPhone: string | null, taskPhone: unknown): boolean {
  const expected = canonico(conversationPhone);
  const got = canonico(taskPhone);
  return Boolean(expected.ok && got.ok && expected.canonico === got.canonico);
}

function idsRelacionados(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor
    .map((item) => (typeof item === 'string' ? item : (item as any)?.id ?? (item as any)?.task_id))
    .filter((id): id is string => typeof id === 'string');
}
