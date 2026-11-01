import { AutomationExecutorService } from './automation-executor.service';

describe('fronteira de eventos do motor', () => {
  const job: any = { organizationId: 'org-b', trigger: 'TAG_ADDED', traceId: 'trace', cascadeDepth: 0, visitedAutomations: [], outboxEventId: 'event', payload: { organizationId: 'org-b', contactId: 'contact-b', conversationId: 'conv-b', channelId: 'channel-b', tagId: 'tag-b', target: 'contact' } };
  const rule = { id: 'rule', organizationId: 'org-b', actorId: 'actor', schemaVersion: 1, conditions: {}, actions: [], rateLimitPerMinute: 10 };
  function setup(valid: boolean) {
    const prisma: any = { automation: { findMany: jest.fn().mockResolvedValue([rule, { ...rule, id: 'rule-2' }]), update: jest.fn().mockResolvedValue({}) }, organization: { findFirst: jest.fn().mockResolvedValue(valid ? { id: 'org-b' } : null) }, userOrganization: { findFirst: jest.fn().mockResolvedValue({ id: 'member' }) }, automationRun: { create: jest.fn().mockResolvedValue({}) } };
    const redis: any = { tryConsumeRateLimit: jest.fn().mockResolvedValue(true), acquireContactLock: jest.fn().mockResolvedValue('lock'), releaseContactLock: jest.fn() };
    const service = new AutomationExecutorService(prisma, { evaluate: () => true } as any, { get: jest.fn() } as any, {} as any, redis, { emitToOrg: jest.fn() } as any);
    return { prisma, redis, service };
  }
  it('pula todas as regras de evento cruzado com uma consulta e sem ações', async () => {
    const { prisma, redis, service } = setup(false);
    await service.execute(job);
    expect(prisma.organization.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.automationRun.create).toHaveBeenCalledTimes(2);
    expect(prisma.automationRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SKIPPED', errorCode: 'cross_org_reference', actionsLog: [] }) }));
    expect(redis.tryConsumeRateLimit).not.toHaveBeenCalled();
  });
  it('executa regra do dono e confere as relações do evento', async () => {
    const { prisma, redis, service } = setup(true);
    await service.execute(job);
    expect(prisma.organization.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'org-b', contacts: { some: { id: 'contact-b' } }, channels: { some: { id: 'channel-b' } }, conversations: { some: expect.objectContaining({ id: 'conv-b', contactId: 'contact-b', channelId: 'channel-b', contact: { organizationId: 'org-b' }, channel: { organizationId: 'org-b' } }) } }) }));
    expect(redis.tryConsumeRateLimit).toHaveBeenCalledTimes(2);
    expect(prisma.automationRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS' }) }));
  });
});
