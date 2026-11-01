import { AddTagHandler } from './add-tag.handler';
import { TagConversationTool } from '../../../ai-agents/tools/builtin/tag-conversation.tool';

describe('fronteira de conversationTag', () => {
  const ctx = { organizationId: 'B', conversationId: 'conversa', contactId: 'contato', channelId: 'canal', agentId: 'agente', runId: 'run' };
  function setup(owner: string) {
    const create = jest.fn(async () => ({}));
    const prisma: any = {
      conversation: { findFirst: jest.fn(async ({ where }: any) => where.organizationId === owner ? { id: 'conversa' } : null) },
      tag: { findFirst: jest.fn(async () => ({ id: 'tag' })), findMany: jest.fn(async () => [{ id: 'tag', name: 'teste' }]), create: jest.fn() },
      conversationTag: { create },
      $transaction: jest.fn(async (fn: any) => typeof fn === 'function' ? fn(prisma) : Promise.all(fn)),
    };
    const outbox: any = { enqueue: jest.fn(async () => {}) };
    return { prisma, outbox, create };
  }
  it.each(['A', 'B'])('handler valida conversa do espaço %s', async (owner) => {
    const { prisma, outbox, create } = setup(owner);
    const result = await new AddTagHandler().execute({ tagId: 'tag', target: 'conversation' }, { organizationId: 'B', payload: { conversationId: 'conversa', contactId: 'contato' }, prisma, outbox } as any);
    expect(result.ok).toBe(owner === 'B');
    if (owner === 'A') expect(result.errorCode).toBe('invalid_ref');
    expect(create).toHaveBeenCalledTimes(owner === 'B' ? 1 : 0);
    expect(outbox.enqueue).toHaveBeenCalledTimes(owner === 'B' ? 1 : 0);
  });
  it.each(['A', 'B'])('ferramenta valida conversa do espaço %s', async (owner) => {
    const { prisma, outbox, create } = setup(owner);
    const result = await new TagConversationTool(prisma, outbox).execute({ tags: ['teste'] }, ctx);
    expect((result.output as any).ok).toBe(owner === 'B');
    expect(create).toHaveBeenCalledTimes(owner === 'B' ? 1 : 0);
    expect(outbox.enqueue).toHaveBeenCalledTimes(owner === 'B' ? 1 : 0);
  });
});
