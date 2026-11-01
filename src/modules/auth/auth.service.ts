import {
  Injectable,
  ForbiddenException,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { SignOptions } from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  ChannelAccessService,
  type ChannelAccess,
} from '../iam/channel-access/channel-access.service';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly channelAccess: ChannelAccessService,
  ) {}

  async register(dto: RegisterDto) {
    if (!dto.inviteToken) throw new ForbiddenException('Cadastro somente por convite.');
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    return this.registerWithInvite(dto, hashedPassword);
  }

  private async registerWithInvite(dto: RegisterDto, hashedPassword: string) {
    // Validate the invitation
    const invitation = await this.prisma.invitation.findUnique({
      where: { token: dto.inviteToken },
      include: { organization: true },
    });

    if (!invitation) {
      throw new BadRequestException('Invalid invitation token');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`Invitation has already been ${invitation.status.toLowerCase()}`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }
    if (invitation.email !== dto.email) {
      throw new BadRequestException('Email does not match the invitation');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          password: hashedPassword,
        },
      });

      // Add user to the invited organization
      const membership = await tx.userOrganization.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          role: invitation.role,
        },
      });

      // Add to default department
      const defaultDept = await tx.department.findFirst({
        where: { organizationId: invitation.organizationId, isDefault: true },
      });

      if (defaultDept) {
        await tx.departmentAgent.create({
          data: {
            departmentId: defaultDept.id,
            userOrganizationId: membership.id,
          },
        });
      }

      // Mark invitation as accepted
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

      // Expire duplicate invitations only in this organization.
      await tx.invitation.updateMany({
        where: {
          organizationId: invitation.organizationId,
          email: dto.email,
          status: 'PENDING',
          id: { not: invitation.id },
        },
        data: { status: 'EXPIRED' },
      });

      return { user, organization: invitation.organization, membership };
    });

    const tokens = await this.generateTokens(result.user.id, result.user.email);
    this.logger.log(`User registered via invitation: ${result.user.email} -> org ${result.organization.name}`);

    return {
      user: this.sanitizeUser(result.user),
      organizations: [{
        id: result.organization.id,
        name: result.organization.name,
        slug: result.organization.slug,
        role: invitation.role,
        // Brand é herdado da org existente (não-OWNERs entrando via convite veem
        // a identidade visual já escolhida pela banca; default visual = A se null).
        brand: result.organization.brand as 'A' | 'B' | 'C' | null,
        accessibleChannelIds: this.serializeChannelAccess(
          await this.channelAccess.getAccessibleChannelIds(
            result.membership.id,
            result.membership.role,
            result.organization.id,
          ),
        ),
      }],
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    const memberships = await this.prisma.userOrganization.findMany({
      where: { userId: user.id },
      include: {
        organization: true,
        channelAgents: { select: { channelId: true } },
      },
    });

    const tokens = await this.generateTokens(user.id, user.email);

    this.logger.log(`User logged in: ${user.email}`);

    const organizations = await Promise.all(
      memberships.map(async (m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
        brand: m.organization.brand as 'A' | 'B' | 'C' | null,
        // S19 Wave 1.1: logo da org no payload de login. Antes só vinha
        // depois do F5+visita em /settings/general (optimistic update).
        // Agora persiste no header do sidebar desde o boot.
        logoUrl: m.organization.logoUrl ?? null,
        // themeTokens (cache do preset ativo) no payload — sem isso o
        // BrandThemeBridge perde a customização no F5 e reverte pro brand
        // base. Mesmo bug do logoUrl (S19 W1.1).
        themeTokens: m.organization.themeTokens ?? null,
        accessibleChannelIds: this.serializeChannelAccess(
          await this.channelAccess.getAccessibleChannelIds(
            m.id,
            m.role,
            m.organizationId,
          ),
        ),
      })),
    );

    return {
      user: this.sanitizeUser(user),
      organizations,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwt.verify<{ sub: string }>(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return this.generateTokens(user.id, user.email);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) throw new UnauthorizedException();

    const memberships = await this.prisma.userOrganization.findMany({
      where: { userId },
      include: {
        organization: true,
        channelAgents: { select: { channelId: true } },
      },
    });

    const organizations = await Promise.all(
      memberships.map(async (m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
        // Brand do tema da banca. null = OWNER ainda não escolheu (wizard).
        // Restringido a 'A'|'B'|'C' no DTO de update; aqui é só passthrough.
        brand: m.organization.brand as 'A' | 'B' | 'C' | null,
        // S19 Wave 1.1: logo da org no payload de /auth/me. Antes só vinha
        // depois do F5+visita em /settings/general (optimistic update).
        // Agora persiste no header do sidebar desde o boot.
        logoUrl: m.organization.logoUrl ?? null,
        // themeTokens (cache do preset ativo) no payload — sem isso o
        // BrandThemeBridge perde a customização no F5 e reverte pro brand
        // base. Mesmo bug do logoUrl (S19 W1.1).
        themeTokens: m.organization.themeTokens ?? null,
        accessibleChannelIds: this.serializeChannelAccess(
          await this.channelAccess.getAccessibleChannelIds(
            m.id,
            m.role,
            m.organizationId,
          ),
        ),
      })),
    );

    return {
      user: this.sanitizeUser(user),
      organizations,
    };
  }

  private serializeChannelAccess(access: ChannelAccess): 'ALL' | string[] {
    return access === 'ALL' ? 'ALL' : [...access];
  }

  private async generateTokens(userId: string, email: string) {
    const payload = { sub: userId, email };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('JWT_SECRET'),
        expiresIn: this.config.get<string>('JWT_EXPIRATION', '15m') as SignOptions['expiresIn'],
      }),
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRATION', '7d') as SignOptions['expiresIn'],
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private sanitizeUser(user: { password: string; [key: string]: unknown }) {
    const { password: _, ...rest } = user;
    return rest;
  }

}
