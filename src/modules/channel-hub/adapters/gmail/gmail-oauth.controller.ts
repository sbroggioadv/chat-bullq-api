import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import type { Response } from 'express';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../../common/guards';
import { CurrentOrg, Roles } from '../../../../common/decorators';
import { GmailOAuthService } from './gmail-oauth.service';

class GmailOAuthStartDto {
  @ApiPropertyOptional({ example: 'Gmail Escritório' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: ['ORG', 'PRIVATE'], default: 'PRIVATE' })
  @IsOptional()
  @IsIn(['ORG', 'PRIVATE'])
  visibility?: 'ORG' | 'PRIVATE';

  @ApiPropertyOptional({ description: 'Reconectar este canal (não cria outro)' })
  @IsOptional()
  @IsString()
  channelId?: string;
}

@ApiTags('Channels / Gmail')
@Controller('channels/gmail')
export class GmailOAuthController {
  constructor(private readonly oauth: GmailOAuthService) {}

  @Get('oauth/status')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
  @ApiOperation({
    summary:
      'Status do conector Gmail (plataforma). Multi-tenant: tokens são por org/canal.',
  })
  status() {
    return this.oauth.status();
  }

  @Post('oauth/start')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
  @Roles(OrgRole.OWNER, OrgRole.ADMIN, OrgRole.AGENT)
  @ApiOperation({
    summary:
      'Inicia OAuth Google da org atual. Devolve URL pra redirecionar o browser (Conectar com Google).',
  })
  start(
    @CurrentOrg() org: { id: string; userOrganizationId: string; userRole: OrgRole },
    @Body() dto: GmailOAuthStartDto,
  ) {
    return this.oauth.start({
      organizationId: org.id,
      userOrganizationId: org.userOrganizationId,
      role: org.userRole,
      name: dto.name,
      visibility: dto.visibility,
      channelId: dto.channelId,
    });
  }

  @Get('oauth/callback')
  @ApiOperation({
    summary:
      'Callback OAuth do Google (público). Cria canal GMAIL na org do state e redireciona pro web.',
  })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const url = await this.oauth.handleCallback(code, state, error);
    return res.redirect(302, url);
  }
}
