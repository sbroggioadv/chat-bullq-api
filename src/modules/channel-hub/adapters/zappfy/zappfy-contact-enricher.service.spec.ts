import { ZappfyContactEnricherService } from './zappfy-contact-enricher.service';

describe('ZappfyContactEnricherService', () => {
  it('propagates a 429 from chat find while keeping other errors as chat_not_found', async () => {
    const prisma: any = { contactChannel: { findUnique: jest.fn().mockResolvedValue({ contact: { avatarUrl: null } }) } };
    const http: any = { sendRequest: jest.fn().mockRejectedValueOnce({ response: { status: 429 }, message: 'limited' }).mockRejectedValueOnce({ response: { status: 500 }, message: 'error' }) };
    const service = new ZappfyContactEnricherService(prisma, http);
    expect(await service.enrich({ id: 'channel' } as any, 'contact')).toEqual({ enriched: false, reason: 'rate_limited' });
    expect(await service.enrich({ id: 'channel' } as any, 'contact')).toEqual({ enriched: false, reason: 'chat_not_found' });
  });
});
