import { AuthService } from './auth.service';

describe('invitation registration organization boundary', () => {
  it('expires duplicate invitations only in the invitation organization and completes registration', async () => {
    const invitation = { id: 'inv-a', organizationId: 'org-a', email: 'person@example.com', role: 'AGENT', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000), organization: { id: 'org-a', name: 'A', slug: 'a' } };
    const tx = {
      user: { create: jest.fn().mockResolvedValue({ id: 'user', email: invitation.email, password: 'hash' }) },
      userOrganization: { create: jest.fn().mockResolvedValue({ id: 'membership', role: 'AGENT' }) },
      department: { findFirst: jest.fn().mockResolvedValue(null) },
      invitation: { update: jest.fn(), updateMany: jest.fn() },
    };
    const prisma = { invitation: { findUnique: jest.fn().mockResolvedValue(invitation) }, $transaction: jest.fn((f) => f(tx)) };
    const service = new AuthService(prisma as any, { signAsync: jest.fn().mockResolvedValue('token') } as any, { get: jest.fn() } as any, { getAccessibleChannelIds: jest.fn().mockResolvedValue('ALL') } as any);
    const result = await (service as any).registerWithInvite({ inviteToken: 'token', email: invitation.email, name: 'Person' }, 'hash');
    expect(result.organizations[0].id).toBe('org-a');
    expect(tx.invitation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-a', email: invitation.email }) }));
  });
});
