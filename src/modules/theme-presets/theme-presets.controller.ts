/**
 * Sprint S18 Wave 4 — Theme Presets Library (Fase 1 backend)
 *
 * 7 endpoints CRUD + activate/deactivate. Todos restritos a OWNER/ADMIN
 * (mesma política da Wave 3 pra tema). Org current resolvido pelo OrgGuard.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { ThemePresetsService } from './theme-presets.service';
import { CreateThemePresetDto } from './dto/create-theme-preset.dto';
import { UpdateThemePresetDto } from './dto/update-theme-preset.dto';

@ApiTags('Theme Presets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('organizations/current/theme-presets')
export class ThemePresetsController {
  constructor(private readonly service: ThemePresetsService) {}

  @Get()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Listar presets de tema da org atual' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.listByOrg(orgId);
  }

  @Get(':presetId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Detalhe de um preset' })
  findOne(
    @CurrentOrg('id') orgId: string,
    @Param('presetId') presetId: string,
  ) {
    return this.service.findOne(orgId, presetId);
  }

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Criar preset nomeado (não ativa). Valida WCAG AA.',
  })
  create(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateThemePresetDto,
  ) {
    return this.service.create(orgId, dto, userId);
  }

  @Patch(':presetId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({
    summary: 'Atualizar preset (nome e/ou tokens). Se for o ativo, cache JSONB é re-pintado.',
  })
  update(
    @CurrentOrg('id') orgId: string,
    @Param('presetId') presetId: string,
    @Body() dto: UpdateThemePresetDto,
  ) {
    return this.service.update(orgId, presetId, dto);
  }

  @Delete(':presetId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deletar preset. Se for o ativo, org volta ao brand base.',
  })
  async delete(
    @CurrentOrg('id') orgId: string,
    @Param('presetId') presetId: string,
  ) {
    await this.service.delete(orgId, presetId);
  }

  @Post(':presetId/activate')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ativar preset (copia tokens pro cache da org).',
  })
  activate(
    @CurrentOrg('id') orgId: string,
    @Param('presetId') presetId: string,
  ) {
    return this.service.activate(orgId, presetId);
  }

  @Post('deactivate')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desativar preset atual (volta ao brand base A/B/C).',
  })
  deactivate(@CurrentOrg('id') orgId: string) {
    return this.service.deactivate(orgId);
  }
}
