/**
 * Sprint S18 Wave 4 — Theme Presets Library (Fase 1 backend)
 *
 * Camada de persistência. Sem regra de negócio — só queries Prisma.
 * Service cuida de validação WCAG, ativação atômica e mapping pra
 * representação API (com `isActive` derivado).
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import type { ThemeTokensShape } from '../organizations/dto/theme-tokens.dto';

@Injectable()
export class ThemePresetsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findManyByOrg(orgId: string) {
    return this.prisma.themePreset.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findById(orgId: string, presetId: string) {
    return this.prisma.themePreset.findFirst({
      where: { id: presetId, orgId },
    });
  }

  async findByName(orgId: string, name: string) {
    return this.prisma.themePreset.findFirst({
      where: { orgId, name },
    });
  }

  async create(
    orgId: string,
    name: string,
    tokens: ThemeTokensShape,
    createdById: string | null,
  ) {
    return this.prisma.themePreset.create({
      data: {
        orgId,
        name,
        tokens: tokens as unknown as Prisma.InputJsonValue,
        createdById: createdById ?? undefined,
      },
    });
  }

  async update(
    presetId: string,
    data: { name?: string; tokens?: ThemeTokensShape },
  ) {
    return this.prisma.themePreset.update({
      where: { id: presetId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.tokens !== undefined
          ? { tokens: data.tokens as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async delete(presetId: string) {
    await this.prisma.themePreset.delete({ where: { id: presetId } });
  }

  /**
   * Ativa um preset em transação: copia tokens pra cache da organização +
   * seta `active_theme_preset_id`. Backward-compat com Wave 3: o frontend
   * continua lendo `org.themeTokens` no hot path.
   */
  async activate(orgId: string, presetId: string, tokens: ThemeTokensShape) {
    return this.prisma.$transaction(async (tx) => {
      return tx.organization.update({
        where: { id: orgId },
        data: {
          activeThemePresetId: presetId,
          themeTokens: tokens as unknown as Prisma.InputJsonValue,
        },
      });
    });
  }

  /**
   * Desativa preset: zera ambos os campos em transação. Frontend volta
   * a usar só `brand` (A/B/C).
   */
  async deactivate(orgId: string) {
    return this.prisma.$transaction(async (tx) => {
      return tx.organization.update({
        where: { id: orgId },
        data: {
          activeThemePresetId: null,
          themeTokens: Prisma.JsonNull,
        },
      });
    });
  }

  async getActivePresetId(orgId: string): Promise<string | null> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { activeThemePresetId: true },
    });
    return org?.activeThemePresetId ?? null;
  }
}
