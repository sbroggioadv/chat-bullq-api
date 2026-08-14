import { MessageDirection, MessageStatus } from '@prisma/client';
import { JarvisDeskRunner } from './jarvis-desk.runner';

describe('JarvisDeskRunner', () => {
  function build(overrides?: { complete?: jest.Mock }) {
    const persist = {
      id: 'm-in',
      conversationId: 'cv1',
      direction: MessageDirection.INBOUND,
      content: { text: 'ok' },
    };
    const prisma = {
      message: {
        findMany: jest.fn().mockResolvedValue([
          {
            direction: MessageDirection.OUTBOUND,
            content: { text: 'oi' },
            sender: { name: 'Luis' },
          },
        ]),
        create: jest.fn().mockResolvedValue(persist),
      },
      conversation: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({
          channelId: 'ch1',
          contactId: 'ct1',
        }),
      },
    };
    const llm = {
      complete: overrides?.complete ?? jest.fn().mockResolvedValue({
        stopReason: 'stop',
        message: { role: 'assistant', content: 'Olá, estou aqui.' },
      }),
    };
    const tools = { execute: jest.fn() };
    const realtime = {
      emitToConversation: jest.fn(),
      emitToChannel: jest.fn(),
    };
    const runner = new JarvisDeskRunner(
      prisma as never,
      llm as never,
      tools as never,
      realtime as never,
    );
    return { runner, prisma, llm, realtime };
  }

  it('emite ai:typing antes de chamar a LLM e persiste a resposta', async () => {
    const { runner, realtime, prisma } = build();
    await runner.handleOperatorMessage({
      organizationId: 'org1',
      conversationId: 'cv1',
      trigger: { id: 'm-out' } as never,
    });

    expect(realtime.emitToConversation).toHaveBeenCalledWith(
      'cv1',
      'ai:typing',
      expect.objectContaining({
        agentName: 'Jarvis',
        conversationId: 'cv1',
      }),
    );
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          direction: MessageDirection.INBOUND,
          status: MessageStatus.DELIVERED,
          content: { text: 'Olá, estou aqui.' },
        }),
      }),
    );
    expect(realtime.emitToConversation).toHaveBeenCalledWith(
      'cv1',
      'message:new',
      expect.objectContaining({ conversationId: 'cv1' }),
    );
  });

  it('grava fallback quando a LLM estoura o timeout', async () => {
    const { runner, prisma } = build({
      complete: jest.fn(
        () => new Promise(() => undefined),
      ),
    });
    jest.useFakeTimers();
    const done = runner.handleOperatorMessage({
      organizationId: 'org1',
      conversationId: 'cv1',
      trigger: { id: 'm-out' } as never,
    });
    await jest.advanceTimersByTimeAsync(26_000);
    await done;
    jest.useRealTimers();

    const created = prisma.message.create.mock.calls[0][0].data;
    expect(created.direction).toBe(MessageDirection.INBOUND);
    expect(String(created.content.text)).toMatch(/Não consegui/);
  });
});
