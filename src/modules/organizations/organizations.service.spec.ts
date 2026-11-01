import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
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

describe('OrganizationsService.inviteMember ownership', () => {
  it('rejects an administrator inviting an owner before creating a membership', async () => {
    const repository = {
      findMembership: jest.fn().mockResolvedValue({ role: OrgRole.ADMIN }),
      findUserByEmail: jest.fn().mockResolvedValue(null),
      createInvitation: jest.fn().mockResolvedValue({ id: 'invite' }),
    };
    const service = new OrganizationsService(repository as any);
    await expect(service.inviteMember('org-a', { email: 'test@example.com', role: OrgRole.OWNER }, 'admin'))
      .rejects.toThrow(ForbiddenException);
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('continues to allow an administrator to invite an agent', async () => {
    const repository = {
      findMembership: jest.fn(),
      findUserByEmail: jest.fn().mockResolvedValue(null),
      createInvitation: jest.fn().mockResolvedValue({ id: 'invite' }),
    };
    const service = new OrganizationsService(repository as any);
    await expect(service.inviteMember('org-a', { email: 'test@example.com', role: OrgRole.AGENT }, 'admin'))
      .resolves.toMatchObject({ id: 'invite' });
  });
});
