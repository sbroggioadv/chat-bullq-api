import { ForbiddenException } from '@nestjs/common';
import { OrgGuard } from './org.guard';

describe('OrgGuard API key organization binding', () => {
  function setup(request: any) {
    const prisma = { userOrganization: { findUnique: jest.fn().mockResolvedValue({ id: 'member-b', role: 'OWNER', organizationId: 'org-b', organization: { name: 'B', slug: 'b' } }) } };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const access = { getAccessibleChannelIds: jest.fn().mockResolvedValue('ALL') };
    const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => request }) };
    return { guard: new OrgGuard(prisma as any, reflector as any, access as any), prisma, context: context as any };
  }

  it('rejects an attempt to switch an API key to another organization even if its owner belongs there', async () => {
    const request = { headers: { 'x-organization-id': 'org-b' }, user: { id: 'user' }, organization: { id: 'org-a' }, apiKeyOrganizationId: 'org-a' };
    const { guard, context, prisma } = setup(request);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(prisma.userOrganization.findUnique).not.toHaveBeenCalled();
  });

  it('accepts the key organization without a header or with a matching header', async () => {
    for (const headers of [{}, { 'x-organization-id': 'org-a' }]) {
      const request = { headers, user: { id: 'user' }, organization: { id: 'org-a' }, apiKeyOrganizationId: 'org-a' };
      const { guard, context } = setup(request);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.organization.id).toBe('org-a');
    }
  });
});

describe('OrgGuard membership', () => {
  it('rejects a JWT user who is not a member of the requested organization', async () => {
    const prisma = { userOrganization: { findUnique: jest.fn().mockResolvedValue(null) } };
    const guard = new OrgGuard(prisma as any, { getAllAndOverride: () => false } as any, {} as any);
    const request = { headers: { 'x-organization-id': 'org-b' }, user: { id: 'user-a' } };
    const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => request }) };
    await expect(guard.canActivate(context as any)).rejects.toThrow(ForbiddenException);
    expect(prisma.userOrganization.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_organizationId: { userId: 'user-a', organizationId: 'org-b' } } }));
  });
});
