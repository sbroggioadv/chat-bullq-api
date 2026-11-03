import { GroupNoReplyService, GroupNoReplyProcessor } from './group-no-reply.service';

it('agenda uma única checagem por mensagem de grupo', async () => {
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const service = new GroupNoReplyService(queue as any);
  await service.schedule({ id: 'c', isGroup: true } as any, { id: 'm' } as any);
  await service.schedule({ id: 'c', isGroup: true } as any, { id: 'm' } as any);
  expect(queue.add).toHaveBeenCalledTimes(2);
  expect(queue.add.mock.calls[0][2]).toEqual(expect.objectContaining({ jobId: 'group-no-reply-m', delay: 900000 }));
  expect(queue.add.mock.calls[1][2].jobId).toBe(queue.add.mock.calls[0][2].jobId);
  await service.schedule({ id: 'i', isGroup: false } as any, { id: 'm2' } as any);
  expect(queue.add).toHaveBeenCalledTimes(2);
});

it.each([
  ['última e autorizada', true, true, true],
  ['outra mensagem posterior', false, true, false],
  ['interruptor ou organização desligados', true, false, false],
])('%s', async (_name, last, allowed, runs) => {
  const conversation = { id: 'c', channelId: 'ch', isGroup: true, isArchived: false };
  const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue(conversation) }, message: { findFirst: jest.fn().mockResolvedValue({ id: last ? 'm' : 'new', direction: 'INBOUND' }) }, aiAgentChannel: { findFirst: jest.fn().mockResolvedValue({ agent: { id: 'a' } }) } };
  const router = { shouldHandle: jest.fn().mockResolvedValue({ handle: allowed }) };
  const runner = { run: jest.fn().mockResolvedValue(undefined) };
  const processor = new GroupNoReplyProcessor(prisma as any, router as any, runner as any);
  await processor.process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
  expect(runner.run).toHaveBeenCalledTimes(runs ? 1 : 0);
});

it.each(['interruptor', 'organização'])('revalida o gate real com %s desligado', async (which) => {
  const { AgentRouterService } = require('../router/agent-router.service');
  const conversation = { id: 'c', organizationId: 'o', channelId: 'ch', isGroup: true, isArchived: false, aiAllowedInGroup: which !== 'interruptor', aiEnabled: null };
  const prisma = {
    conversation: { findUnique: jest.fn().mockResolvedValue(conversation) },
    message: { findFirst: jest.fn().mockResolvedValue({ id: 'm', direction: 'INBOUND', content: 'oi' }) },
    organization: { findUnique: jest.fn().mockImplementation(({ select }: any) => Promise.resolve(select ? { aiPanicMode: false } : { id: 'o', aiEnabled: which !== 'organização' })) },
    channel: { findUnique: jest.fn().mockResolvedValue({ type: 'WHATSAPP', aiEnabled: true }) },
    aiAgentChannel: { findFirst: jest.fn() },
  };
  const router = new AgentRouterService(prisma as any, {} as any, {} as any);
  const runner = { run: jest.fn() };
  await new GroupNoReplyProcessor(prisma as any, router, runner as any).process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
  expect(runner.run).not.toHaveBeenCalled();
  expect(prisma.aiAgentChannel.findFirst).not.toHaveBeenCalled();
});

it('não executa checagem individual', async () => {
  const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue({ isGroup: false }) }, message: { findFirst: jest.fn() } };
  const runner = { run: jest.fn() };
  await new GroupNoReplyProcessor(prisma as any, {} as any, runner as any).process({ data: { conversationId: 'c', messageId: 'm', minutes: 15 } } as any);
  expect(prisma.message.findFirst).not.toHaveBeenCalled();
  expect(runner.run).not.toHaveBeenCalled();
});

it.each([
  [true, true, 1], [true, false, 0], [false, true, 0],
])('agendamento na entrada: grupo=%s gate=%s', async (group, allowed, expected) => {
  const { InboundMessageProcessor } = require('../../messaging/pipeline/inbound-message.processor');
  const processor = Object.create(InboundMessageProcessor.prototype);
  processor.prisma = {
    conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c', isGroup: group }) },
    message: { findUnique: jest.fn().mockResolvedValue({ id: 'm', type: 'TEXT', content: 'oi' }) },
  };
  processor.agentRouter = { shouldHandle: jest.fn().mockResolvedValue({ handle: allowed }) };
  processor.groupNoReply = { schedule: jest.fn().mockResolvedValue(undefined) };
  processor.scheduleAgentRun = jest.fn();
  processor.realtimeGateway = { emitToConversation: jest.fn() };
  processor.logger = { debug: jest.fn(), error: jest.fn() };
  await processor.tryAiAgent('c', 'm');
  expect(processor.groupNoReply.schedule).toHaveBeenCalledTimes(expected);
  expect(processor.scheduleAgentRun).toHaveBeenCalledTimes(allowed ? 1 : 0);
});
