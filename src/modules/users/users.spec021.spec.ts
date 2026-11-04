import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';

describe('SPEC-021 pinned conversations', () => {
  let pins: any[];
  let preferences: any;
  let prisma: any;
  let service: UsersService;
  beforeEach(() => {
    pins = [];
    preferences = { inbox: { scope: 'ALL' } };
    prisma = {
      conversation: { findFirst: jest.fn(async ({ where }: any) => where.id === 'foreign' ? null : { channelId: where.id === 'denied' ? 'denied' : 'allowed' }) },
      userOrganization: { findUnique: jest.fn(async () => ({ preferences })) },
      $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: any[]) => {
        const sql = parts.join('?');
        if (!sql.includes('jsonb_set')) {
          preferences = { ...preferences, ...JSON.parse(values[0]) };
          return [{ preferences }];
        }
        const pin = values[0];
        const id = values[1];
        if (pin && pins.length >= 20 && !pins.some(p => p.id === id)) return [];
        if (pin && !pins.some(p => p.id === id)) pins.push(JSON.parse(values[2]));
        if (!pin) pins = pins.filter(p => p.id !== id);
        preferences = { ...preferences, pinnedConversations: pins };
        return [{ pinned: [...pins] }];
      }),
    };
    service = new UsersService(prisma, { assertChannelAccess: (access: any, channel: string) => { if (access !== 'ALL' && !access.has(channel)) throw new ForbiddenException(); } } as any);
  });
  it('keeps concurrent pins and preserves them on general PATCH', async () => {
    await Promise.all([service.setPinned('u', 'org', 'one', true, 'ALL'), service.setPinned('u', 'org', 'two', true, 'ALL')]);
    await service.updatePreferences('u', 'org', { inbox: { scope: 'MINE' }, pinnedConversations: [] });
    expect(preferences.pinnedConversations.map((p: any) => p.id)).toEqual(['one', 'two']);
    expect(preferences.inbox.scope).toBe('MINE');
    const pinSql = prisma.$queryRaw.mock.calls[0][0].join('?');
    expect(pinSql).toContain('UPDATE user_organizations SET preferences = jsonb_set');
    expect(pinSql).toContain('jsonb_array_length');
    expect(pinSql).toContain("@> jsonb_build_array(jsonb_build_object('id'");
    expect(pinSql).toContain("|| jsonb_build_array(");
    expect(prisma.$queryRaw.mock.calls[2][0].join('?')).toContain("COALESCE(preferences, '{}'::jsonb) ||");
  });
  it('limits pins to 20, is idempotent, and refuses foreign or denied conversations', async () => {
    for (let i = 0; i < 20; i++) await service.setPinned('u', 'org', String(i), true, 'ALL');
    await service.setPinned('u', 'org', '0', true, 'ALL');
    await expect(service.setPinned('u', 'org', '21', true, 'ALL')).rejects.toThrow('pin_limit_reached');
    await expect(service.setPinned('u', 'org', 'foreign', true, 'ALL')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.setPinned('u', 'org', 'denied', true, new Set())).rejects.toBeInstanceOf(ForbiddenException);
    await service.setPinned('u', 'org', '0', false, 'ALL');
    await service.setPinned('u', 'org', '0', false, 'ALL');
    expect(pins).toHaveLength(19);
  });
});
