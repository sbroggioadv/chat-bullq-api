import { ForbiddenException } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { OrganizationsController } from './organizations.controller';

describe('organization invitation endpoint', () => {
  it('rejects ADMIN inviting OWNER before calling the service', () => {
    const service = { inviteMember: jest.fn() };
    const controller = new OrganizationsController(service as any);
    expect(() => (controller.invite as any)('org-a', { email: 'test@example.com', role: OrgRole.OWNER }, 'admin', OrgRole.ADMIN)).toThrow(ForbiddenException);
    expect(service.inviteMember).not.toHaveBeenCalled();
  });
  it('allows ADMIN inviting AGENT and OWNER inviting OWNER', () => {
    const service = { inviteMember: jest.fn().mockReturnValue('ok') };
    const controller = new OrganizationsController(service as any);
    expect((controller.invite as any)('org-a', { email: 'test@example.com', role: OrgRole.AGENT }, 'admin', OrgRole.ADMIN)).toBe('ok');
    expect((controller.invite as any)('org-a', { email: 'test@example.com', role: OrgRole.OWNER }, 'owner', OrgRole.OWNER)).toBe('ok');
    expect(service.inviteMember).toHaveBeenCalledTimes(2);
  });
});
