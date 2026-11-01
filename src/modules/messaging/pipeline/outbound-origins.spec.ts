import { OutboundMessageProcessor } from './outbound-message.processor';
import { MessagesService } from '../messages/messages.service';
import { ChatbotProcessor } from '../../chatbot/engine/chatbot.processor';
import { ReplyToConversationTool } from '../../ai-agents/tools/builtin/reply-to-conversation.tool';
import { SendMessageHandler } from '../../automations/actions/handlers/send-message.handler';

describe('envio do dono pelas quatro origens', () => {
  const conversation: any = { id: 'conv', organizationId: 'org', channelId: 'channel', contactId: 'contact', channel: { type: 'TEST' }, contact: { channels: [{ channelId: 'channel', externalId: 'synthetic' }] }, assignedToId: 'actor', aiEnabled: false };
  const gateway: any = { emitToConversation: jest.fn(), emitToChannel: jest.fn(), emitToUserInOrg: jest.fn() };
  let queue: any, prisma: any, send: jest.Mock;
  beforeEach(() => {
    send = jest.fn().mockResolvedValue({ externalId: 'external' });
    prisma = { channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'channel', type: 'TEST', organizationId: 'org' }) }, message: { create: jest.fn().mockResolvedValue({ id: 'msg', conversationId: 'conv' }), findUniqueOrThrow: jest.fn().mockResolvedValue({ conversation: { id: 'conv', organizationId: 'org' } }), findUnique: jest.fn().mockResolvedValue({ metadata: {} }), update: jest.fn().mockResolvedValue({ id: 'msg', conversationId: 'conv' }) }, conversation: { findFirst: jest.fn().mockResolvedValue(conversation), findUnique: jest.fn().mockResolvedValue({ ...conversation, organization: { allowedUrlDomains: null } }), update: jest.fn() }, conversationRead: { upsert: jest.fn() }, organization: { findUnique: jest.fn().mockResolvedValue({ aiAutoDisableOnHuman: false }) }, aiAgent: { findUnique: jest.fn().mockResolvedValue({ name: 'Agente' }) }, contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'synthetic' }) } };
    const processor = new OutboundMessageProcessor(prisma, { getOutbound: () => ({ sendMessage: send }) } as any, gateway, { markProcessed: jest.fn() } as any);
    queue = { add: jest.fn(async (_name: string, data: any) => processor.process({ data } as any)) };
  });
  it('humano', async () => {
    const service = new MessagesService({ create: jest.fn().mockResolvedValue({ id: 'msg', conversationId: 'conv' }) } as any, prisma, gateway, { assertChannelAccess: jest.fn() } as any, { cancelCheck: jest.fn().mockResolvedValue(undefined) } as any, {} as any, {} as any, {} as any, {} as any, queue);
    await service.send({ conversationId: 'conv', type: 'TEXT', content: { text: 'Olá' } } as any, 'actor', 'org');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('chatbot', async () => {
    const bot = new ChatbotProcessor({ processMessage: jest.fn().mockResolvedValue({ messages: [{ type: 'TEXT', content: { text: 'Olá' } }], transferToHuman: false }) } as any, prisma, queue);
    await bot.process({ data: { conversationId: 'conv', channelId: 'channel', contactExternalId: 'synthetic', organizationId: 'org', messageText: 'Olá' } } as any);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('agente', async () => {
    const tool = new ReplyToConversationTool(prisma, gateway, queue);
    await tool.execute({ text: 'Olá' }, { conversationId: 'conv', channelId: 'channel', contactId: 'contact', agentId: 'agent', runId: 'run' } as any);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('automação', async () => {
    const handler = new SendMessageHandler(queue);
    const result = await handler.execute({ body: 'Olá' }, { organizationId: 'org', payload: { conversationId: 'conv' }, prisma, actorId: 'actor', traceId: 'trace' } as any);
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
