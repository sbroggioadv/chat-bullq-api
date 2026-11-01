import { SegmentLookupService } from './segment-lookup.service';

describe('segmento e canais por organização', () => {
  const segment = (channelOrg: string, primaryOrg: string) => ({ channel: { organizationId: channelOrg }, segment: { id: 'seg-b', organizationId: 'org-b', primaryChannelId: 'principal', primaryChannel: { organizationId: primaryOrg }, members: [{ channel: { organizationId: 'org-a', config: { ownPhone: '111' } } }, { channel: { organizationId: 'org-b', config: { ownPhone: '222' } } }] } });
  it('não roteia membro ou principal de outra organização', async () => {
    for (const row of [segment('org-a', 'org-b'), segment('org-b', 'org-a')]) {
      const svc = new SegmentLookupService({ segmentChannel: { findMany: jest.fn().mockResolvedValue([row]), findFirst: jest.fn().mockResolvedValue(row) } } as any);
      expect(await svc.forChannel('canal')).toBeNull();
    }
  });
  it('preserva canal e números da organização dona', async () => {
    const row = segment('org-b', 'org-b');
    const svc = new SegmentLookupService({ segmentChannel: { findMany: jest.fn().mockResolvedValue([row]), findFirst: jest.fn().mockResolvedValue(row) } } as any);
    expect(await svc.forChannel('canal')).toEqual({ segmentId: 'seg-b', primaryChannelId: 'principal', ownNumbers: new Set(['222']) });
  });
});
