import { ConversationStatus } from '@prisma/client';
import { ConversationResolverService } from './conversation-resolver.service';
import { SegmentReadService } from '../../segments/segment-read.service';
import { GroupNotifyService } from '../../ai-agents/tools/client-ops/group-notify.service';

// Regressão de GRUPOS com conversa arquivada pelo usuário (a limpeza de
// duplicadas não toca grupos: is_group=false no 02-aplicar.sql). Fixa o
// comportamento esperado depois de excluir arquivadas no resolvedor.

const JID = '120363000000000000@g.us';

describe('grupo arquivado — inbound ao vivo', () => {
  it('nova mensagem no grupo cuja única conversa está arquivada → cria conversa de grupo nova (a arquivada fica intacta)', async () => {
    const arquivada = { id: 'grupo-arquivado', organizationId: 'org', channelId: 'ch', contactId: 'grupo', status: ConversationStatus.OPEN, isArchived: true, isGroup: true };
    const prisma = {
      conversation: {
        findFirst: jest.fn(async ({ where }: any) => {
          const statusOk = where.status?.in ? where.status.in.includes(arquivada.status) : where.status === arquivada.status;
          const archivedOk = where.isArchived === undefined || where.isArchived === arquivada.isArchived;
          return statusOk && archivedOk && where.contactId === arquivada.contactId ? arquivada : null;
        }),
        create: jest.fn().mockResolvedValue({ id: 'grupo-novo' }),
        update: jest.fn(),
      },
      conversationAuditLog: { create: jest.fn() },
    };
    const resolver = new ConversationResolverService(prisma as any, { withLock: (_k: string, fn: () => unknown) => fn() } as any);

    const r = await resolver.resolve('org', 'ch', 'grupo', true);

    expect(r).toMatchObject({ conversationId: 'grupo-novo', isNew: true });
    expect(prisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isGroup: true, contactId: 'grupo' }) }));
    expect(prisma.conversation.update).not.toHaveBeenCalled();
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
