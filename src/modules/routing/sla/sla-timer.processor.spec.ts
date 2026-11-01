import { SlaTimerProcessor } from './sla-timer.processor';

describe('SLA por organização', () => {
  it('não notifica com dados de conversa de outro espaço', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue({ id: 'a', contact: { name: 'Pessoa A' } }) } };
    const notifications = { notifyOrgAgents: jest.fn(), notify: jest.fn() };
    const result = await new SlaTimerProcessor(prisma as any, notifications as any).process({ data: { conversationId: 'a', organizationId: 'b', type: 'first-response' } } as any);
    expect(result).toEqual({ skipped: true, reason: 'conversation_not_found' });
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a', organizationId: 'b' } }));
    expect(notifications.notifyOrgAgents).not.toHaveBeenCalled();
  });
  it('recusa job sem organização antes da consulta', async () => {
    const prisma = { conversation: { findFirst: jest.fn() } };
    const notifications = { notifyOrgAgents: jest.fn(), notify: jest.fn() };
    const result = await new SlaTimerProcessor(prisma as any, notifications as any).process({ data: { conversationId: 'a', type: 'first-response' } } as any);
    expect(result).toEqual({ skipped: true, reason: 'conversation_not_found' });
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
  });
  it('notifica normalmente quando conversa e job pertencem ao espaço', async () => {
    const prisma = { conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'a', contact: { name: 'Pessoa A' } }), findUnique: jest.fn().mockResolvedValue({ id: 'a', contact: { name: 'Pessoa A' } }) } };
    const notifications = { notifyOrgAgents: jest.fn(), notify: jest.fn() };
    const result = await new SlaTimerProcessor(prisma as any, notifications as any).process({ data: { conversationId: 'a', organizationId: 'a', type: 'first-response' } } as any);
    expect(result).toEqual({ breach: true, type: 'first-response' });
    expect(notifications.notifyOrgAgents).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'a' }));
  });
});
