import { PipelinesService } from './pipelines.service';

describe('board por organização', () => {
  const card = () => ({ id: 'card-b', stageId: 'etapa', contactId: 'contato-b', assignedToId: 'user-b', conversationId: 'conv-b', contact: { id: 'contato-b', organizationId: 'org-b' }, assignedTo: { id: 'user-b', name: 'B', avatarUrl: null, organizations: [{ organizationId: 'org-b' }] }, conversation: { id: 'conv-b', organizationId: 'org-b', channelId: 'canal-b', channel: { id: 'canal-b', organizationId: 'org-b' } } });
  const boardFor = async (item: ReturnType<typeof card>) => {
    const prisma: any = { pipeline: { findFirst: jest.fn().mockResolvedValue({ id: 'pipeline' }) }, pipelineStage: { findMany: jest.fn().mockResolvedValue([{ id: 'etapa' }]) }, card: { findMany: jest.fn().mockResolvedValue([item, card()]) }, $transaction: (p: any[]) => Promise.all(p) };
    return (await new PipelinesService(prisma, {} as any).getBoard('pipeline', 'org-b')).cards.etapa;
  };

  it('oculta contato alheio e preserva contato próprio', async () => {
    const item = card(); item.contact.organizationId = 'org-a';
    const [foreign, own] = await boardFor(item);
    expect([foreign.contactId, foreign.contact]).toEqual([null, null]);
    expect(own.contactId).toBe('contato-b');
    expect(own.contact?.id).toBe('contato-b');
  });

  it('oculta responsável alheio e preserva responsável próprio', async () => {
    const item = card(); item.assignedTo.organizations = [{ organizationId: 'org-a' }];
    const [foreign, own] = await boardFor(item);
    expect([foreign.assignedToId, foreign.assignedTo]).toEqual([null, null]);
    expect(own.assignedToId).toBe('user-b');
    expect(own.assignedTo?.id).toBe('user-b');
  });

  it('oculta conversa alheia e preserva conversa própria', async () => {
    const item = card(); item.conversation.organizationId = 'org-a';
    const [foreign, own] = await boardFor(item);
    expect([foreign.conversationId, foreign.conversation]).toEqual([null, null]);
    expect(own.conversationId).toBe('conv-b');
    expect(own.conversation?.channelId).toBe('canal-b');
  });

  it('oculta conversa própria com canal alheio e mantém o card', async () => {
    const item = card(); item.conversation.channel.organizationId = 'org-a';
    const [foreign, own] = await boardFor(item);
    expect(foreign.id).toBe('card-b');
    expect([foreign.conversationId, foreign.conversation]).toEqual([null, null]);
    expect(own.conversationId).toBe('conv-b');
    expect(own.conversation?.channel?.id).toBe('canal-b');
  });
});
