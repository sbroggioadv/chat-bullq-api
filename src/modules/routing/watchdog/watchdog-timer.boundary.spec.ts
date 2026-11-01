import { WatchdogTimerProcessor } from './watchdog-timer.processor';
import { WATCHDOG_CHECK_JOB, WATCHDOG_FALLBACK_JOB } from './watchdog.types';

describe('organização do job watchdog', () => {
  function setup() {
    const prisma = { conversation: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() } };
    const cron = { scanAndEnqueue: jest.fn().mockResolvedValue('fallback') };
    const processor = new WatchdogTimerProcessor(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, cron as any);
    return { prisma, cron, processor };
  }
  it('recusa job sem organização antes da consulta', async () => {
    const { processor, prisma } = setup();
    expect(await processor.process({ name: WATCHDOG_CHECK_JOB, data: { conversationId: 'c' } } as any)).toEqual({ skipped: true, reason: 'conversation_not_found' });
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
  });
  it('consulta apenas a conversa da organização do job', async () => {
    const { processor, prisma } = setup();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await processor.process({ name: WATCHDOG_CHECK_JOB, data: { conversationId: 'c', organizationId: 'B' } } as any);
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c', organizationId: 'B' } }));
  });
  it('processa conversa legítima e mantém fallback global', async () => {
    const { processor, prisma, cron } = setup();
    prisma.conversation.findFirst.mockResolvedValue({ deletedAt: new Date() });
    expect(await processor.process({ name: WATCHDOG_CHECK_JOB, data: { conversationId: 'c', organizationId: 'A' } } as any)).toEqual({ skipped: true, reason: 'conversation_deleted' });
    expect(await processor.process({ name: WATCHDOG_FALLBACK_JOB, data: {} } as any)).toBe('fallback');
    expect(cron.scanAndEnqueue).toHaveBeenCalled();
  });
});
