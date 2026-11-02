import { Logger } from '@nestjs/common';
import { InstagramContactEnricherService } from './instagram-contact-enricher.service';

describe('InstagramContactEnricherService', () => {
  let prisma: any;
  let http: any;
  let service: InstagramContactEnricherService;
  beforeEach(() => {
    prisma = { contactChannel: { findUnique: jest.fn().mockResolvedValue({ id: 'cc', contactId: 'c', contact: {} }), update: jest.fn() }, contact: { update: jest.fn() } };
    http = { getUserProfile: jest.fn() };
    service = new InstagramContactEnricherService(prisma, http);
  });
  afterEach(() => jest.restoreAllMocks());
  it('logs the status and a safe short message for profile errors', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    http.getUserProfile.mockRejectedValue({ response: { status: 429 }, message: 'Request failed with status code 429' });
    await service.enrich({ id: 'channel' } as any, '12345678');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/429.*5678|5678.*429/));
  });
  it('continues to save name and picture', async () => {
    http.getUserProfile.mockResolvedValue({ username: 'user', profile_pic: 'https://example.test/avatar' });
    await service.enrich({ id: 'channel' } as any, '12345678');
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: 'c' }, data: { name: 'user', avatarUrl: 'https://example.test/avatar' } });
  });
});
