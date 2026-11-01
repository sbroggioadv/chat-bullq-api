import { PipelinesService } from './pipelines.service';

describe('board por organização', () => {
  it('zera referências alheias e mantém card e referências próprias', async () => {
    const card = (org: string) => ({ id: `card-${org}`, stageId: 'etapa', contactId: `contato-${org}`, assignedToId: `user-${org}`, conversationId: `conv-${org}`, contact: { id: `contato-${org}`, organizationId: org }, assignedTo: { id: `user-${org}`, name: org, avatarUrl: null, organizations: [{ organizationId: org }] }, conversation: { id: `conv-${org}`, organizationId: org, channelId: `canal-${org}`, channel: { id: `canal-${org}`, organizationId: org } } });
    const crossChannel = card('org-b'); crossChannel.id = 'card-canal'; crossChannel.conversation.channel.organizationId = 'org-a';
    const prisma: any = { pipeline: { findFirst: jest.fn().mockResolvedValue({ id: 'pipeline' }) }, pipelineStage: { findMany: jest.fn().mockResolvedValue([{ id: 'etapa' }]) }, card: { findMany: jest.fn().mockResolvedValue([card('org-a'), card('org-b'), crossChannel]) }, $transaction: (p: any[]) => Promise.all(p) };
    const board = await new PipelinesService(prisma, {} as any).getBoard('pipeline', 'org-b');
    const [foreign, own, channel] = board.cards.etapa;
    expect([foreign.contactId, foreign.contact, foreign.assignedToId, foreign.assignedTo, foreign.conversationId, foreign.conversation]).toEqual([null, null, null, null, null, null]);
    expect(own.contactId).toBe('contato-org-b');
    expect(own.assignedToId).toBe('user-org-b');
    expect(own.conversation?.channelId).toBe('canal-org-b');
    expect(channel.conversationId).toBeNull();
    expect(channel.conversation).toBeNull();
  });
});
