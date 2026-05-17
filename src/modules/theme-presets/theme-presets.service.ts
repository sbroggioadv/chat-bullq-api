/**
 * Sprint S18 Wave 4 — Theme Presets Library (Fase 1 backend)
 *
 * Lógica de negócio:
 * - WCAG AA: rejeita 422 se contraste falhar (reusa validateThemeContrast da Wave 3)
 * - Nome único por org: rejeita 409 em conflito
 * - Activate: transação que atualiza FK + cache JSONB
 * - Cascata: delete de preset ativo zera activeThemePresetId via ON DELETE SET NULL
 *
 * Saída sempre normalizada via `toResponse()` com `isActive` derivado.
 */

import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import type { ThemePreset } from '@prisma/client';
import { ThemePresetsRepository } from './theme-presets.repository';
import { CreateThemePresetDto } from './dto/create-theme-preset.dto';
import { UpdateThemePresetDto } from './dto/update-theme-preset.dto';
import { validateThemeContrast } from '../organizations/util/theme-contrast.util';
import type { ThemeTokensShape } from '../organizations/dto/theme-tokens.dto';

export interface ThemePresetResponse {
  id: string;
  orgId: string;
  name: string;
  tokens: ThemeTokensShape;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  isActive: boolean;
}

@Injectable()
export class ThemePresetsService {
  private readonly logger = new Logger(ThemePresetsService.name);

  constructor(private readonly repository: ThemePresetsRepository) {}

  async listByOrg(orgId: string): Promise<ThemePresetResponse[]> {
    const [presets, activeId] = await Promise.all([
      this.repository.findManyByOrg(orgId),
      this.repository.getActivePresetId(orgId),
    ]);
    return presets.map((p) => this.toResponse(p, activeId));
  }

  async findOne(orgId: string, presetId: string): Promise<ThemePresetResponse> {
    const preset = await this.repository.findById(orgId, presetId);
    if (!preset) throw new NotFoundException('Theme preset não encontrado');
    const activeId = await this.repository.getActivePresetId(orgId);
    return this.toResponse(preset, activeId);
  }

  async create(
    orgId: string,
    dto: CreateThemePresetDto,
    userId: string | null,
  ): Promise<ThemePresetResponse> {
    this.assertWcag(dto.tokens as ThemeTokensShape);

    const existing = await this.repository.findByName(orgId, dto.name);
    if (existing) {
      throw new ConflictException(
        `Já existe um preset chamado "${dto.name}" nesta organização`,
      );
    }

    const preset = await this.repository.create(
      orgId,
      dto.name,
      dto.tokens as ThemeTokensShape,
      userId,
    );
    this.logger.log(`Preset "${dto.name}" criado (org ${orgId}, id ${preset.id})`);

    const activeId = await this.repository.getActivePresetId(orgId);
    return this.toResponse(preset, activeId);
  }

  async update(
    orgId: string,
    presetId: string,
    dto: UpdateThemePresetDto,
  ): Promise<ThemePresetResponse> {
    if (dto.name === undefined && dto.tokens === undefined) {
      throw new BadRequestException(
        'Payload vazio — envie ao menos `name` ou `tokens`',
      );
    }

    const preset = await this.repository.findById(orgId, presetId);
    if (!preset) throw new NotFoundException('Theme preset não encontrado');

    if (dto.tokens !== undefined) {
      this.assertWcag(dto.tokens as ThemeTokensShape);
    }

    if (dto.name !== undefined && dto.name !== preset.name) {
      const sameName = await this.repository.findByName(orgId, dto.name);
      if (sameName && sameName.id !== presetId) {
        throw new ConflictException(
          `Já existe um preset chamado "${dto.name}" nesta organização`,
        );
      }
    }

    const updated = await this.repository.update(presetId, {
      name: dto.name,
      tokens: dto.tokens as ThemeTokensShape | undefined,
    });

    // Se o preset alterado é o ATIVO e tokens mudaram, atualiza o cache
    // pra refletir imediatamente sem requerer re-activate manual.
    if (dto.tokens !== undefined) {
      const activeId = await this.repository.getActivePresetId(orgId);
      if (activeId === presetId) {
        await this.repository.activate(
          orgId,
          presetId,
          dto.tokens as ThemeTokensShape,
        );
        this.logger.log(
          `Cache de tokens atualizado pro preset ativo ${presetId} (org ${orgId})`,
        );
      }
    }

    const activeId = await this.repository.getActivePresetId(orgId);
    return this.toResponse(updated, activeId);
  }

  async delete(orgId: string, presetId: string): Promise<void> {
    const preset = await this.repository.findById(orgId, presetId);
    if (!preset) throw new NotFoundException('Theme preset não encontrado');

    // ON DELETE SET NULL na FK cuida automaticamente do active_theme_preset_id.
    // Mas o cache JSONB `theme_tokens` precisa ser limpo manualmente —
    // o banco não sabe que é cache derivado. Fazemos em transação leve:
    // se este é o ativo, zera o cache antes de deletar.
    const activeId = await this.repository.getActivePresetId(orgId);
    if (activeId === presetId) {
      await this.repository.deactivate(orgId);
    }

    await this.repository.delete(presetId);
    this.logger.log(`Preset "${preset.name}" deletado (org ${orgId})`);
  }

  async activate(orgId: string, presetId: string) {
    const preset = await this.repository.findById(orgId, presetId);
    if (!preset) throw new NotFoundException('Theme preset não encontrado');

    const tokens = preset.tokens as unknown as ThemeTokensShape;
    const org = await this.repository.activate(orgId, presetId, tokens);
    this.logger.log(`Preset "${preset.name}" ativado (org ${orgId})`);
    return org;
  }

  async deactivate(orgId: string) {
    const org = await this.repository.deactivate(orgId);
    this.logger.log(`Theme preset desativado (org ${orgId})`);
    return org;
  }

  // ─── Helpers ────────────────────────────────────────────

  private assertWcag(tokens: ThemeTokensShape) {
    const errors = validateThemeContrast({
      light: {
        primary: tokens.light.primary,
        accent: tokens.light.accent,
        danger: tokens.light.danger,
      },
      dark: {
        primary: tokens.dark.primary,
        accent: tokens.dark.accent,
        danger: tokens.dark.danger,
      },
    });
    if (errors.length > 0) {
      throw new UnprocessableEntityException({
        message: 'Tema falha WCAG AA',
        errors,
      });
    }
  }

  private toResponse(preset: ThemePreset, activeId: string | null): ThemePresetResponse {
    return {
      id: preset.id,
      orgId: preset.orgId,
      name: preset.name,
      tokens: preset.tokens as unknown as ThemeTokensShape,
      createdAt: preset.createdAt.toISOString(),
      updatedAt: preset.updatedAt.toISOString(),
      createdBy: preset.createdById,
      isActive: activeId === preset.id,
    };
  }
}
