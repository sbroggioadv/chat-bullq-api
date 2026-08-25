import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { STATUS } from './domain/casamento';
import { canonico } from './domain/telefone';
import { idSeguro } from './domain/ids';
import { montarCampoCard, serializeFieldValue } from './domain/campos';
import { montarComentario, pareceSensivel } from './domain/comentario';
import {
  criarOuRecuperarAtividade,
  MemoryAtividadeKv,
} from './domain/criacao-atividade';
import { ClickUpInboxConfigService } from './clickup-inbox-config.service';
import { ClickUpInboxHttpClient } from './clickup-inbox-http.client';
import { ClickUpMatchService } from './clickup-match.service';
import {
  activitiesUnavailable,
  conversationNotFound,
  invalidValue,
  mapUpstream,
  orgForbidden,
  taskNotBound,
} from './clickup-inbox.errors';

const HTTPS = /^https:\/\//i;

@Injectable()
export class ClickUpInboxService {
  private readonly atividadeKv = new MemoryAtividadeKv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ClickUpInboxConfigService,
    private readonly http: ClickUpInboxHttpClient,
    private readonly match: ClickUpMatchService,
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
    const conv = await this.prepareBound(organizationId, conversationId, taskId);
    try {
      const card = await this.cardCompleto(taskId, conv.contact.phone);
      return { status: STATUS.UNICO, conversationId: conv.id, card };
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
    const conv = await this.prepareBound(organizationId, conversationId, taskId);
    try {
      const cardAntes = await this.cardCompleto(taskId, conv.contact.phone);
      if (!cardAntes.etapas.includes(status)) {
        invalidValue('status fora da lista permitida');
      }
      await this.http.write(`/task/${encodeURIComponent(taskId)}`, { status }, 'PUT');
      const card = await this.cardCompleto(taskId, conv.contact.phone);
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
    if (!idSeguro(fieldId)) invalidValue('campo inválido');
    const conv = await this.prepareBound(organizationId, conversationId, taskId);
    const profile = this.config.profile();
    try {
      const cardAntes = await this.cardCompleto(taskId, conv.contact.phone);
      const campo = cardAntes.campos.find((item) => item.id === fieldId);
      if (!campo) taskNotBound('campo ausente da task');
      if (!campo.writable || profile.blockedFieldIds.includes(fieldId)) {
        invalidValue('campo bloqueado ou somente leitura');
      }
      const serialized = serializeFieldValue(campo.tipo, value);
      if (!serialized.ok) invalidValue(serialized.erro);
      await this.http.write(
        `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`,
        { value: serialized.value },
      );
      const card = await this.cardCompleto(taskId, conv.contact.phone);
      if (fieldId === profile.whatsappFieldId) {
        this.match.invalidate(organizationId);
      }
      return {
        ok: true,
        valor: card.campos.find((item) => item.id === fieldId)?.valor ?? null,
        card,
      };
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
    const conv = await this.prepareBound(organizationId, conversationId, taskId);
    if (pareceSensivel(dto.oQue)) invalidValue('o texto parece conter informação sensível');
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
      await this.cardCompleto(taskId, conv.contact.phone);
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
    const conv = await this.prepareBound(organizationId, conversationId, taskId);
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
          await this.assertTaskBound(taskId, conv.contact.phone);
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
          const card = await this.cardCompleto(taskId, conv.contact.phone);
          return { ok: true, atividadeId, card };
        },
        compensar: (atividadeId) => this.http.apagarTask(atividadeId),
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  async completeActivity(
    organizationId: string,
    conversationId: string,
    taskId: string,
    activityId: string,
  ) {
    if (!idSeguro(activityId)) invalidValue('atividade inválida');
    const conv = await this.prepareBound(organizationId, conversationId, taskId);
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
      const card = await this.cardCompleto(taskId, conv.contact.phone);
      return { ok: true, status: confirmacao.status?.status ?? concluido, card };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      mapUpstream(err);
    }
  }

  assertOrg(organizationId: string) {
    const snap = this.config.snapshot();
    if (snap.ok && snap.organizationId !== organizationId) orgForbidden();
    if (!snap.ok) this.config.assertLocal();
  }

  private async ensureRemote() {
    await this.config.ensureRemote(() => this.http.validateRemoteConfig());
  }

  private async prepareBound(organizationId: string, conversationId: string, taskId: string) {
    this.assertOrg(organizationId);
    if (!idSeguro(taskId)) invalidValue('task inválida');
    const conv = await this.loadConversation(organizationId, conversationId);
    if (conv.isGroup) taskNotBound('grupo não casa com um único card');
    await this.ensureRemote();
    await this.assertTaskBound(taskId, conv.contact.phone);
    return conv;
  }

  private async loadConversation(organizationId: string, conversationId: string) {
    if (!idSeguro(conversationId)) conversationNotFound();
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, deletedAt: null },
      select: {
        id: true,
        isGroup: true,
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
    const campos = metadados.map((campo) =>
      montarCampoCard(campo, valores.get(campo.id) ?? null, blocked),
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

function phoneFromTask(task: any, whatsappFieldId: string): unknown {
  return (task.custom_fields ?? []).find((campo: { id?: string }) => campo.id === whatsappFieldId)
    ?.value ?? null;
}

function idsRelacionados(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor
    .map((item) => (typeof item === 'string' ? item : (item as any)?.id ?? (item as any)?.task_id))
    .filter((id): id is string => typeof id === 'string');
}
