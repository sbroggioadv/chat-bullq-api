import { ChannelType, ConversationStatus, MessageDirection, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { IdempotencyService } from './idempotency.service';
import { ConversationResolverService } from './conversation-resolver.service';
import { HistoryImportService } from './history-import.service';

// Grupo arquivado no PostgreSQL local descartável: a conversa do grupo é
// desarquivada e reutilizada, nunca duplicada. Pessoa segue a regra antiga
// (arquivada fica de fora e nasce conversa nova). No importador, o grupo só
// volta à caixa se a sincronização trouxer mensagem nova. Dados sintéticos
// com prefixo único; só roda com HANDOFF_PG_URL apontando para o banco handoff.

const url = process.env.HANDOFF_PG_URL;
const suite = url ? describe : describe.skip;
const HOUR = 60 * 60 * 1000;

suite('Grupo arquivado no PostgreSQL local descartável', () => {
  let db: PrismaClient;
  let resolver: ConversationResolverService;
  let importer: HistoryImportService;
  const prefix = `synthetic-grupo-arquivado-${process.pid}-${Date.now()}`;
  const organizationId = `${prefix}-org`;
  const channelId = `${prefix}-channel`;
  const userId = `${prefix}-user`;
  const channel = { id: channelId, organizationId, type: ChannelType.WHATSAPP_ZAPPFY } as any;
  let sequence = 0;

  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/handoff') {
      throw new Error('Use apenas o banco local descartável handoff');
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.organization.create({ data: { id: organizationId, name: 'Synthetic', slug: organizationId } });
    await db.user.create({ data: { id: userId, name: 'Synthetic', email: `${prefix}@example.test`, password: 'synthetic' } });
    await db.channel.create({ data: { id: channelId, organizationId, name: 'Synthetic', type: 'WHATSAPP_ZAPPFY', config: {} } });
    const idempotency = { withLock: (_key: string, fn: () => Promise<unknown>) => fn() };
    resolver = new ConversationResolverService(db as unknown as PrismaService, idempotency as unknown as IdempotencyService);
    importer = new HistoryImportService(db as unknown as PrismaService, {} as RealtimeGateway);
  });
  afterAll(async () => {
    if (!db) return;
    await db.conversation.deleteMany({ where: { organizationId } });
    await db.contact.deleteMany({ where: { organizationId } });
    await db.channel.deleteMany({ where: { id: channelId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
    await db.$disconnect();
  });

  const contact = async () => {
    const id = `${prefix}-contact-${++sequence}`;
    const jid = `${prefix}-${sequence}@g.us`;
    await db.contact.create({ data: { id, organizationId, name: `Contato sintético ${sequence}` } });
    await db.contactChannel.create({ data: { contactId: id, channelId, externalId: jid, profileName: `Contato sintético ${sequence}` } });
    return { id, jid };
  };
  const conversation = (contactId: string, data: Record<string, unknown>) => db.conversation.create({
    data: { id: `${prefix}-conversation-${++sequence}`, organizationId, channelId, contactId, ...data },
  });
  const count = (contactId: string) => db.conversation.count({ where: { organizationId, contactId } });
  const actions = async (conversationId: string) =>
    (await db.conversationAuditLog.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }))
      .map((log) => ({ action: log.action, metadata: log.metadata }));

  describe('resolvedor ao vivo', () => {
    it('grupo com única conversa OPEN arquivada → devolve essa conversa, desarquiva e não cria nova', async () => {
      const { id: contactId } = await contact();
      const arquivada = await conversation(contactId, {
        isGroup: true, status: ConversationStatus.OPEN, isArchived: true, archivedAt: new Date(), archivedById: userId,
      });

      const result = await resolver.resolve(organizationId, channelId, contactId, true);

      expect(result).toEqual({ conversationId: arquivada.id, status: ConversationStatus.OPEN, isNew: false, wasReopened: false });
      const after = await db.conversation.findUniqueOrThrow({ where: { id: arquivada.id } });
      expect(after).toEqual(expect.objectContaining({ isArchived: false, archivedAt: null, archivedById: null, status: ConversationStatus.OPEN }));
      expect(await count(contactId)).toBe(1);
      expect(await actions(arquivada.id)).toEqual([
        { action: 'UNARCHIVED', metadata: { trigger: 'new_inbound_message', isGroup: true } },
      ]);
    });

    it('grupo com conversa CLOSED arquivada há mais de 24h → reabre (PENDING) e desarquiva, sem nova', async () => {
      const { id: contactId } = await contact();
      const closedAt = new Date(Date.now() - 48 * HOUR);
      const fechada = await conversation(contactId, {
        isGroup: true, status: ConversationStatus.CLOSED, closedAt, assignedToId: userId,
        isArchived: true, archivedAt: closedAt, archivedById: userId,
      });

      const result = await resolver.resolve(organizationId, channelId, contactId, true);

      expect(result).toEqual({ conversationId: fechada.id, status: ConversationStatus.PENDING, isNew: false, wasReopened: true });
      const after = await db.conversation.findUniqueOrThrow({ where: { id: fechada.id } });
      expect(after).toEqual(expect.objectContaining({
        status: ConversationStatus.PENDING, closedAt: null, assignedToId: null, isArchived: false, archivedAt: null, archivedById: null,
      }));
      expect(await count(contactId)).toBe(1);
      expect(await actions(fechada.id)).toEqual(expect.arrayContaining([
        { action: 'UNARCHIVED', metadata: { trigger: 'new_inbound_message', isGroup: true } },
        { action: 'REOPENED', metadata: { trigger: 'new_inbound_message', isGroup: true } },
      ]));
      expect(await actions(fechada.id)).toHaveLength(2);
    });

    it('grupo cuja única conversa é extra fundida (cleanup_merged_into) → cria nova e a fundida fica intacta', async () => {
      const { id: contactId } = await contact();
      const fundida = await conversation(contactId, {
        isGroup: true, status: ConversationStatus.OPEN, isArchived: true, archivedAt: new Date(),
        metadata: { cleanup_merged_into: `${prefix}-original-apagada` },
      });

      const result = await resolver.resolve(organizationId, channelId, contactId, true);

      expect(result).toEqual(expect.objectContaining({ isNew: true, wasReopened: false, status: ConversationStatus.PENDING }));
      expect(result.conversationId).not.toBe(fundida.id);
      expect(await db.conversation.findUniqueOrThrow({ where: { id: fundida.id } })).toEqual(fundida);
      expect(await count(contactId)).toBe(2);
      const nova = await db.conversation.findUniqueOrThrow({ where: { id: result.conversationId } });
      expect(nova).toEqual(expect.objectContaining({ isGroup: true, isArchived: false, contactId }));
    });

    it('PESSOA (isGroup false) com única conversa arquivada → cria nova e a arquivada fica intacta (regra inalterada)', async () => {
      const { id: contactId } = await contact();
      const arquivada = await conversation(contactId, {
        isGroup: false, status: ConversationStatus.OPEN, isArchived: true, archivedAt: new Date(), archivedById: userId,
      });

      const result = await resolver.resolve(organizationId, channelId, contactId, false);

      expect(result).toEqual(expect.objectContaining({ isNew: true, wasReopened: false }));
      expect(result.conversationId).not.toBe(arquivada.id);
      expect(await db.conversation.findUniqueOrThrow({ where: { id: arquivada.id } })).toEqual(arquivada);
      expect(await count(contactId)).toBe(2);
      expect(await actions(arquivada.id)).toEqual([]);
    });

    it('idempotência: duas chamadas seguidas de resolve(..., true) no grupo arquivado → mesma conversa, count segue 1', async () => {
      const { id: contactId } = await contact();
      const arquivada = await conversation(contactId, { isGroup: true, status: ConversationStatus.OPEN, isArchived: true, archivedAt: new Date() });

      const primeira = await resolver.resolve(organizationId, channelId, contactId, true);
      const segunda = await resolver.resolve(organizationId, channelId, contactId, true);

      expect(primeira.conversationId).toBe(arquivada.id);
      expect(segunda).toEqual({ conversationId: arquivada.id, status: ConversationStatus.OPEN, isNew: false, wasReopened: false });
      expect(await count(contactId)).toBe(1);
      expect(await actions(arquivada.id)).toHaveLength(1);
    });
  });

  describe('importador de histórico (sincronização)', () => {
    const marco = new Date(Date.now() - 2 * HOUR); // arquivamento / fechamento
    const normalized = (jid: string, isGroup = true) =>
      ({ externalConversationId: jid, externalContactId: jid, isGroup, lastMessageAt: new Date() }) as any;
    const msg = (jid: string, externalMessageId: string, timestamp: Date) => ({
      externalMessageId, externalConversationId: jid, externalContactId: jid,
      direction: MessageDirection.INBOUND, timestamp, type: 'TEXT', content: { text: 'sintética' },
    }) as any;
    const seed = async (data: Record<string, unknown>) => {
      const { id: contactId, jid } = await contact();
      const conv = await conversation(contactId, { isGroup: true, lastMessageAt: new Date(marco.getTime() - HOUR), ...data });
      await db.message.create({ data: {
        conversationId: conv.id, direction: MessageDirection.INBOUND, type: 'TEXT', content: { text: 'antiga' },
        externalId: `${jid}-antiga`, createdAt: new Date(marco.getTime() - HOUR),
      } });
      return { contactId, jid, conv };
    };
    const sync = async (jid: string, messages: unknown[]) => {
      const conv = await importer.importConversation(channel, normalized(jid));
      const msgs = await importer.importMessages(channel, conv.conversationId, messages as any);
      return { conv, msgs };
    };

    it('sync sem mensagem nova (só external_id já gravado) → reutiliza a arquivada e ela fica intacta (arquivada)', async () => {
      const { contactId, jid, conv } = await seed({ status: ConversationStatus.OPEN, isArchived: true, archivedAt: marco, archivedById: userId });

      const { conv: result, msgs } = await sync(jid, [msg(jid, `${jid}-antiga`, new Date(marco.getTime() - HOUR))]);

      expect(result).toEqual({ conversationId: conv.id, contactId, isNew: false });
      expect(msgs).toEqual({ imported: 0, skipped: 1 });
      const after = await db.conversation.findUniqueOrThrow({ where: { id: conv.id } });
      expect(after).toEqual(expect.objectContaining({ isArchived: true, archivedAt: marco, archivedById: userId, status: ConversationStatus.OPEN }));
      expect(await count(contactId)).toBe(1);
      expect(await actions(conv.id)).toEqual([]);
    });

    it('sync com mensagem ainda não gravada mas ANTERIOR ao arquivamento → importa e continua arquivada', async () => {
      const { contactId, jid, conv } = await seed({ status: ConversationStatus.OPEN, isArchived: true, archivedAt: marco, archivedById: userId });

      const { msgs } = await sync(jid, [msg(jid, `${jid}-historica`, new Date(marco.getTime() - 30 * 60_000))]);

      expect(msgs).toEqual({ imported: 1, skipped: 0 });
      const after = await db.conversation.findUniqueOrThrow({ where: { id: conv.id } });
      expect(after).toEqual(expect.objectContaining({ isArchived: true, archivedAt: marco }));
      expect(await count(contactId)).toBe(1);
      expect(await actions(conv.id)).toEqual([]);
    });

    it('sync com mensagem NOVA (não gravada e posterior ao arquivamento) → desarquiva a mesma conversa, sem nova', async () => {
      const { contactId, jid, conv } = await seed({ status: ConversationStatus.OPEN, isArchived: true, archivedAt: marco, archivedById: userId });

      const { conv: result, msgs } = await sync(jid, [
        msg(jid, `${jid}-antiga`, new Date(marco.getTime() - HOUR)),
        msg(jid, `${jid}-nova`, new Date(Date.now() - 60_000)),
      ]);

      expect(result).toEqual({ conversationId: conv.id, contactId, isNew: false });
      expect(msgs).toEqual({ imported: 1, skipped: 1 });
      const after = await db.conversation.findUniqueOrThrow({ where: { id: conv.id } });
      expect(after).toEqual(expect.objectContaining({ isArchived: false, archivedAt: null, archivedById: null, status: ConversationStatus.OPEN }));
      expect(await count(contactId)).toBe(1);
      expect(await actions(conv.id)).toEqual([
        { action: 'UNARCHIVED', metadata: { trigger: 'history_import_new_message', isGroup: true } },
      ]);
    });

    it('grupo com conversa CLOSED: sync sem mensagem nova reutiliza e mantém fechada; com mensagem nova reabre (PENDING); nunca cria nova', async () => {
      const { contactId, jid, conv } = await seed({ status: ConversationStatus.CLOSED, closedAt: marco, assignedToId: userId });

      const semNova = await sync(jid, [msg(jid, `${jid}-antiga`, new Date(marco.getTime() - HOUR))]);
      expect(semNova.conv).toEqual({ conversationId: conv.id, contactId, isNew: false });
      expect(await db.conversation.findUniqueOrThrow({ where: { id: conv.id } }))
        .toEqual(expect.objectContaining({ status: ConversationStatus.CLOSED, closedAt: marco, assignedToId: userId }));

      const comNova = await sync(jid, [msg(jid, `${jid}-nova`, new Date(Date.now() - 60_000))]);
      expect(comNova.conv).toEqual({ conversationId: conv.id, contactId, isNew: false });
      expect(comNova.msgs).toEqual({ imported: 1, skipped: 0 });
      expect(await db.conversation.findUniqueOrThrow({ where: { id: conv.id } }))
        .toEqual(expect.objectContaining({ status: ConversationStatus.PENDING, closedAt: null, assignedToId: null, isArchived: false }));
      expect(await count(contactId)).toBe(1);
      expect(await actions(conv.id)).toEqual([
        { action: 'REOPENED', metadata: { trigger: 'history_import_new_message', isGroup: true } },
      ]);
    });

    it('grupo cuja única conversa é extra fundida → importa em conversa nova e a fundida fica intacta', async () => {
      const { contactId, jid, conv } = await seed({
        status: ConversationStatus.OPEN, isArchived: true, archivedAt: marco,
        metadata: { cleanup_merged_into: `${prefix}-original-apagada` },
      });

      const { conv: result } = await sync(jid, [msg(jid, `${jid}-nova`, new Date(Date.now() - 60_000))]);

      expect(result).toEqual(expect.objectContaining({ contactId, isNew: true }));
      expect(result.conversationId).not.toBe(conv.id);
      expect(await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).toEqual(conv);
      expect(await count(contactId)).toBe(2);
    });

    it('PESSOA (isGroup false) com única conversa arquivada → importa em conversa nova (regra inalterada)', async () => {
      const { id: contactId, jid } = await contact();
      const arquivada = await conversation(contactId, { isGroup: false, status: ConversationStatus.OPEN, isArchived: true, archivedAt: marco });

      const result = await importer.importConversation(channel, normalized(jid, false));

      expect(result).toEqual(expect.objectContaining({ contactId, isNew: true }));
      expect(await db.conversation.findUniqueOrThrow({ where: { id: arquivada.id } })).toEqual(arquivada);
      expect(await count(contactId)).toBe(2);
    });
  });
});
