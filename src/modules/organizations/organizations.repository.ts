import { Injectable } from '@nestjs/common';
import { Prisma, OrgRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { randomBytes } from 'crypto';

@Injectable()
export class OrganizationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findBySlug(slug: string) {
    return this.prisma.organization.findFirst({
      where: { slug, deletedAt: null },
    });
  }

  async update(id: string, data: Prisma.OrganizationUpdateInput) {
    return this.prisma.organization.update({ where: { id }, data });
  }

  async findMembers(organizationId: string) {
    return this.prisma.userOrganization.findMany({
      where: { organizationId },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true, isActive: true },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }

  /**
   * Aceita tanto o `userOrganization.id` (membership id, vem do listMembers
   * no frontend e é o que faz mais sentido pra rotas /members/:memberId)
   * quanto o `userId` (compatibilidade com chamadas legadas que passavam
   * o id do user direto). Tenta o id de membership primeiro porque é o
   * caso semanticamente correto da URL.
   */
  async findMembership(memberIdOrUserId: string, organizationId: string) {
    const byMembershipId = await this.prisma.userOrganization.findFirst({
      where: { id: memberIdOrUserId, organizationId },
    });
    if (byMembershipId) return byMembershipId;
    return this.prisma.userOrganization.findUnique({
      where: {
        userId_organizationId: { userId: memberIdOrUserId, organizationId },
      },
    });
  }

  async addMember(organizationId: string, userId: string, role: 'OWNER' | 'ADMIN' | 'AGENT') {
    return this.prisma.userOrganization.create({
      data: { organizationId, userId, role },
    });
  }

  async updateMemberRole(membershipId: string, role: 'OWNER' | 'ADMIN' | 'AGENT') {
    return this.prisma.userOrganization.update({
      where: { id: membershipId },
      data: { role },
    });
  }

  async removeMember(membershipId: string) {
    return this.prisma.userOrganization.delete({
      where: { id: membershipId },
    });
  }

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async countMembers(organizationId: string) {
    return this.prisma.userOrganization.count({ where: { organizationId } });
  }

  // ─── Invitation methods ───────────────────────────

  async createInvitation(organizationId: string, email: string, role: OrgRole, invitedById: string) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    return this.prisma.invitation.create({
      data: {
        organizationId,
        email,
        role,
        token,
        invitedById,
        expiresAt,
      },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  async findInvitationByToken(token: string) {
    return this.prisma.invitation.findUnique({
      where: { token },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  async findPendingInvitationsByEmail(email: string) {
    return this.prisma.invitation.findMany({
      where: {
        email,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  async acceptInvitation(invitationId: string) {
    return this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
  }

  async revokeInvitation(invitationId: string) {
    return this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED' },
    });
  }

  async findInvitationsByOrg(organizationId: string) {
    return this.prisma.invitation.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: {
        invitedBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  /**
   * S19 Wave 3: cria uma nova organizacao para um usuario existente.
   *
   * Pattern espelhado de auth.service.registerNewWorkspace (que cria user +
   * org no signup). Aqui o user ja existe — so criamos a Org + UserOrganization
   * (OWNER) + Department "Geral" default em uma unica transacao pra evitar
   * estado intermediario inutil se algo falhar.
   *
   * O slug e gerado deterministicamente a partir do nome + suffix `Date.now()`
   * base36 — mesma estrategia do auth.service, garante unicidade sem retry loop.
   */
  async createWorkspace(params: {
    userId: string;
    name: string;
    slug: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: params.name,
          slug: params.slug,
        },
      });

      const userOrganization = await tx.userOrganization.create({
        data: {
          userId: params.userId,
          organizationId: organization.id,
          role: 'OWNER',
        },
      });

      const defaultDepartment = await tx.department.create({
        data: {
          organizationId: organization.id,
          name: 'Geral',
          description: 'Departamento padrao',
          isDefault: true,
        },
      });

      await tx.departmentAgent.create({
        data: {
          departmentId: defaultDepartment.id,
          userOrganizationId: userOrganization.id,
        },
      });

      return { organization, userOrganization };
    });
  }
}
