import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyAuthGuard } from './api-key-auth.guard';

/**
 * Composite authentication guard — accepts EITHER a JWT (browser/SPA flow)
 * OR an API key (`Authorization: pk_*`, machine-to-machine flow).
 *
 * Motivation (Sprint "COO Reativo", D7):
 * The `/automations` controller is consumed by two distinct clients:
 *  - the bullq2 web frontend, authenticated with a short-lived JWT;
 *  - the n8n COO workflows, which run headless and authenticate with a
 *    long-lived organization API key (`pk_*`).
 *
 * Applying `ApiKeyAuthGuard` alone would break the frontend; keeping only
 * the JWT pipeline blocks n8n. This guard routes by the shape of the
 * `Authorization` header so neither client is affected.
 *
 * Important — the two paths populate `request` differently:
 *  - JWT path: `JwtAuthGuard` sets `request.user`; the controller still needs
 *    `OrgGuard` downstream to resolve `request.organization` from the
 *    `x-organization-id` header.
 *  - API key path: `ApiKeyStrategy` already resolves and sets BOTH
 *    `request.organization` and `request.user` (the key is org-bound), so
 *    `OrgGuard` is satisfied — it just reads what the strategy populated.
 *
 * `RolesGuard` keeps working in both paths because the API key strategy
 * attaches the membership/role to the resolved user.
 */
@Injectable()
export class JwtOrApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtGuard: JwtAuthGuard,
    private readonly apiKeyGuard: ApiKeyAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const header =
      request.headers.authorization ||
      (request.headers as Record<string, string>).Authorization;

    const rawKey =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7).trim()
        : (header ?? '').trim();

    // `pk_*` token shape → machine-to-machine path (n8n COO workflows).
    if (rawKey.startsWith('pk_')) {
      return (await this.apiKeyGuard.canActivate(context)) as boolean;
    }

    // Anything else → standard JWT path (web frontend).
    if (!header) {
      throw new UnauthorizedException('Missing authentication credentials');
    }
    return (await this.jwtGuard.canActivate(context)) as boolean;
  }
}
