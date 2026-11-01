import { ChatbotProcessor } from './chatbot.processor';

describe('fronteira do processamento do chatbot', () => {
  it('recusa job cuja conversa não pertence ao espaço e canal informados', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue(null) } };
    const engine = { processMessage: jest.fn() };
    const result = await new ChatbotProcessor(engine as any, prisma as any, {} as any).process({ data: { conversationId: 'a', channelId: 'canal-b', organizationId: 'b' } } as any);
    expect(result).toEqual({ skipped: true, reason: 'conversation_not_found' });
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({ where: { id: 'a', channelId: 'canal-b', organizationId: 'b' }, select: { id: true } });
    expect(engine.processMessage).not.toHaveBeenCalled();
  });
  it('recusa departamento de outro espaço antes de enviar ou transferir', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'a' }), update: jest.fn() }, department: { findFirst: jest.fn().mockResolvedValue(null) }, message: { create: jest.fn() } };
    const engine = { processMessage: jest.fn().mockResolvedValue({ messages: [], transferToHuman: true, transferDepartmentId: 'dep-b' }) };
    const result = await new ChatbotProcessor(engine as any, prisma as any, {} as any).process({ data: { conversationId: 'a', channelId: 'canal-a', organizationId: 'a' } } as any);
    expect(result).toEqual({ skipped: true, reason: 'department_not_found' });
    expect(prisma.department.findFirst).toHaveBeenCalledWith({ where: { id: 'dep-b', organizationId: 'a', deletedAt: null }, select: { id: true } });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
  it('mantém transferência para departamento do espaço', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'a' }), update: jest.fn() }, department: { findFirst: jest.fn().mockResolvedValue({ id: 'dep-a' }) }, conversationAuditLog: { create: jest.fn() } };
    const engine = { processMessage: jest.fn().mockResolvedValue({ messages: [], transferToHuman: true, transferDepartmentId: 'dep-a' }) };
    const result = await new ChatbotProcessor(engine as any, prisma as any, {} as any).process({ data: { conversationId: 'a', channelId: 'canal-a', organizationId: 'a' } } as any);
    expect(result.transferred).toBe(true);
    expect(prisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ departmentId: 'dep-a' }) }));
  });
});
