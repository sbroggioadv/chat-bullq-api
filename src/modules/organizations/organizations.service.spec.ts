import { BadRequestException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';

function buildService(invitation: any) {
  const repository = {
    findInvitationByToken: jest.fn(async () => invitation),
  };
  return {
    service: new OrganizationsService(repository as any),
    repository,
  };
}

const organization = { id: 'org1', name: 'BullQ', slug: 'bullq' };

describe('OrganizationsService.validateInvitation', () => {
  it('returns pending invitation data with status', async () => {
    const { service } = buildService({
      email: 'marcela@example.com',
      role: 'AGENT',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
      organization,
    });

    await expect(service.validateInvitation('token')).resolves.toEqual({
      email: 'marcela@example.com',
      role: 'AGENT',
      status: 'PENDING',
      organization,
    });
  });

  it('returns accepted invitation data so existing users can be guided to login', async () => {
    const { service } = buildService({
      email: 'marcela@example.com',
      role: 'AGENT',
      status: 'ACCEPTED',
      expiresAt: new Date(Date.now() - 60_000),
      organization,
    });

    await expect(service.validateInvitation('token')).resolves.toEqual({
      email: 'marcela@example.com',
      role: 'AGENT',
      status: 'ACCEPTED',
      organization,
    });
  });

  it('still rejects revoked invitations', async () => {
    const { service } = buildService({
      email: 'marcela@example.com',
      role: 'AGENT',
      status: 'REVOKED',
      expiresAt: new Date(Date.now() + 60_000),
      organization,
    });

    await expect(service.validateInvitation('token')).rejects.toThrow(
      BadRequestException,
    );
  });
});
