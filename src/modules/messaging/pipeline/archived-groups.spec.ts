import { ChannelType, ConversationStatus } from '@prisma/client';
import { ConversationResolverService } from './conversation-resolver.service';
import { HistoryImportService } from './history-import.service';
import { SegmentReadService } from '../../segments/segment-read.service';
import { GroupNotifyService } from '../../ai-agents/tools/client-ops/group-notify.service';

// Regressão de GRUPOS com conversa arquivada pelo usuário. Grupo não encerra:
// arquivar só tira da lista, e a conversa volta quando o grupo fala — é
// desarquivada e reutilizada, nunca duplicada (decisão do dono do produto,
// 06/11). Extra fundida (marca cleanup_merged_into) segue fora da escolha.

const JID = '120363000000000000@g.us';

describe('grupo arquivado — inbound ao vivo', () => {
  function setup(rows: Array<Record<string, unknown>>) {
    const prisma = {
      conversation: {
        findMany: jest.fn(async ({ where, skip = 0, take }: any) => {
          const hits = rows.filter((c: any) => {
            const statusOk = where.status === undefined
              || (where.status?.in ? where.status.in.includes(c.status) : where.status === c.status);
            const archivedOk = where.isArchived === undefined || where.isArchived === c.isArchived;
            return statusOk && archivedOk && where.contactId === c.contactId;
          });
          return take === undefined ? hits.slice(skip) : hits.slice(skip, skip + take);
        }),
        create: jest.fn().mockResolvedValue({ id: 'grupo-novo' }),
        update: jest.fn(),
      },
      conversationAuditLog: { create: jest.fn() },
    };
    const resolver = new ConversationResolverService(prisma as any, { withLock: (_k: string, fn: () => unknown) => fn() } as any);
    return { prisma, resolver };
  }
  const base = { organizationId: 'org', channelId: 'ch', contactId: 'grupo', isGroup: true, metadata: {} };

  it('nova mensagem no grupo cuja única conversa está arquivada → desarquiva e reutiliza essa conversa (nenhuma nova)', async () => {
    const { prisma, resolver } = setup([{ ...base, id: 'grupo-arquivado', status: ConversationStatus.OPEN, isArchived: true }]);

    const r = await resolver.resolve('org', 'ch', 'grupo', true);

    expect(r).toEqual({ conversationId: 'grupo-arquivado', status: ConversationStatus.OPEN, isNew: false, wasReopened: false });
    expect(prisma.conversation.update).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'grupo-arquivado' },
      data: expect.objectContaining({ isArchived: false, archivedAt: null, archivedById: null }),
    });
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(prisma.conversationAuditLog.create).toHaveBeenCalledWith({
      data: { conversationId: 'grupo-arquivado', action: 'UNARCHIVED', metadata: { trigger: 'new_inbound_message', isGroup: true } },
    });
  });

  it('única conversa do grupo é extra fundida (arquivada) → cria nova e a fundida fica intacta', async () => {
    const { prisma, resolver } = setup([
      { ...base, id: 'extra-fundida', status: ConversationStatus.OPEN, isArchived: true, metadata: { cleanup_merged_into: 'original-apagada' } },
    ]);

    const r = await resolver.resolve('org', 'ch', 'grupo', true);

    expect(r).toMatchObject({ conversationId: 'grupo-novo', isNew: true });
    expect(prisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isGroup: true, contactId: 'grupo' }) }));
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
});

describe('grupo arquivado — importador de histórico (sincronização)', () => {
  const archivedAt = new Date('2026-11-05T10:00:00Z');
  const channel: any = { id: 'ch', organizationId: 'org', type: ChannelType.WHATSAPP_ZAPPFY };
  const arquivada = {
    id: 'grupo-arquivado', organizationId: 'org', channelId: 'ch', contactId: 'grupo', status: ConversationStatus.OPEN,
    isArchived: true, archivedAt, isGroup: true, closedAt: null, updatedAt: archivedAt, lastMessageAt: archivedAt, metadata: {},
  };
  function setup(gravadas: string[] = []) {
    const prisma: any = {
      contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'cc', contactId: 'grupo', profileName: 'Grupo', contact: { organizationId: 'org' } }), update: jest.fn() },
      conversation: {
        findMany: jest.fn(async ({ where }: any) => {
          const statusOk = where.status === undefined || where.status.in?.includes(arquivada.status);
          const archivedOk = where.isArchived === undefined || where.isArchived === arquivada.isArchived;
          return !where.metadata && statusOk && archivedOk && where.contactId === arquivada.contactId ? [arquivada] : [];
        }),
        findUnique: jest.fn().mockResolvedValue(arquivada),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'grupo-novo' }),
      },
      message: { findMany: jest.fn().mockResolvedValue(gravadas.map((externalId) => ({ externalId }))), createMany: jest.fn() },
      conversationAuditLog: { create: jest.fn() },
    };
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    return { prisma, svc: new HistoryImportService(prisma, {} as any) };
  }
  const msg = (externalMessageId: string, timestamp: Date): any =>
    ({ externalMessageId, externalConversationId: JID, externalContactId: JID, direction: 'INBOUND', timestamp, type: 'TEXT', content: {} });

  it('importConversation de grupo reutiliza a conversa arquivada sem desarquivar (nenhuma nova)', async () => {
    const { prisma, svc } = setup();

    const r = await svc.importConversation(channel, { externalConversationId: JID, externalContactId: JID, isGroup: true });

    expect(r).toEqual({ conversationId: 'grupo-arquivado', contactId: 'grupo', isNew: false });
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isArchived: expect.anything() }) }));
  });

  it('importMessages sem mensagem nova (external_id já gravado) não desarquiva', async () => {
    const { prisma, svc } = setup(['ja-gravada']);

    await svc.importMessages(channel, 'grupo-arquivado', [msg('ja-gravada', new Date('2026-11-06T10:00:00Z'))]);

    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversationAuditLog.create).not.toHaveBeenCalled();
  });

  it('importMessages com mensagem nova posterior ao arquivamento desarquiva a conversa do grupo', async () => {
    const { prisma, svc } = setup();

    await svc.importMessages(channel, 'grupo-arquivado', [msg('nova', new Date('2026-11-06T10:00:00Z'))]);

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'grupo-arquivado' },
      data: { isArchived: false, archivedAt: null, archivedById: null },
    });
    expect(prisma.conversationAuditLog.create).toHaveBeenCalledWith({
      data: { conversationId: 'grupo-arquivado', action: 'UNARCHIVED', metadata: { trigger: 'history_import_new_message', isGroup: true } },
    });
  });
});

describe('grupo arquivado — segmento (unificação por leitura)', () => {
  function service(convs: Array<{ id: string; channelId: string; lastMessageAt: Date | null; isArchived: boolean }>) {
    const prisma = {
      segment: { findFirst: jest.fn().mockResolvedValue({ members: [{ channelId: 'ch-1' }, { channelId: 'ch-2' }] }) },
      segmentChannel: {
        findFirst: jest.fn().mockResolvedValue({ segmentId: 'seg', segment: { members: [{ channelId: 'ch-1' }, { channelId: 'ch-2' }] } }),
      },
      conversation: {
        findMany: jest.fn().mockResolvedValue(convs.map((c) => ({ ...c, contact: { channels: [{ channelId: c.channelId, externalId: JID }] } }))),
        findUnique: jest.fn().mockResolvedValue({ organizationId: 'org', channelId: 'ch-1', isGroup: true, contact: { channels: [{ channelId: 'ch-1', externalId: JID }] } }),
      },
    };
    return { svc: new SegmentReadService(prisma as any), prisma };
  }
  const convs = [
    { id: 'grupo-arquivado', channelId: 'ch-1', lastMessageAt: new Date('2026-10-01T10:00:00Z'), isArchived: true },
    { id: 'grupo-novo', channelId: 'ch-1', lastMessageAt: new Date('2026-11-02T10:00:00Z'), isArchived: false },
  ];

  it('a conversa nova (mais recente) vira a representante do grupo na caixa', async () => {
    const { svc } = service(convs);

    const r = await svc.groupRepresentativeIds('org', 'seg');

    expect(r.representativeIds).toEqual(['grupo-novo']);
  });

  it('a arquivada continua como irmã: a timeline unificada mantém o histórico antigo; o vínculo de segmento não muda', async () => {
    const { svc, prisma } = service(convs);

    const irmas = await svc.groupSiblingIds('grupo-novo');

    expect(irmas).toEqual(['grupo-arquivado', 'grupo-novo']);
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ isArchived: expect.anything() }),
    }));
  });
});

describe('grupo arquivado — aviso proativo da IA (group-notify)', () => {
  function setup(found: { id: string } | null) {
    const prisma = {
      contactChannel: { findFirst: jest.fn().mockResolvedValue({ contactId: 'grupo', channelId: 'ch', externalId: JID }) },
      conversation: { findFirst: jest.fn().mockResolvedValue(found), update: jest.fn() },
      message: { create: jest.fn().mockResolvedValue({ id: 'msg' }) },
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const svc = new GroupNotifyService(prisma as any, { emitToChannel: jest.fn(), emitToConversation: jest.fn() } as any, queue as any);
    return { svc, prisma, queue };
  }

  it('mantido: escolhe a conversa do grupo pela mais recente, sem filtro de arquivada, e envia ao JID do grupo', async () => {
    const { svc, prisma, queue } = setup({ id: 'grupo-arquivado' });

    const r = await svc.notifyGroupByJid({ organizationId: 'org', groupJid: JID, text: 'aviso', currentConversationId: 'outra', senderName: 'Sofia' });

    expect(r).toEqual({ sent: true });
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { contactId: 'grupo', channelId: 'ch' },
      orderBy: { lastMessageAt: 'desc' },
    }));
    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conversationId: 'grupo-arquivado' }) }));
    expect(queue.add).toHaveBeenCalledWith('send-outbound', expect.objectContaining({ contactExternalId: JID }), expect.anything());
  });
});
