/**
 * Sprint S18 Wave 3 — Theme Builder OKLCH PRO (Fase 1 backend)
 *
 * Shape do `Organization.themeTokens`. Validação:
 * - `base` é uma das brands (A/B/C) — usada como ponto de partida
 *   no Builder UI pra "Reset" e como referência pra tokens derivados
 *   (hover, soft, fg) que não são persistidos
 * - Cores em formato OKLCH literal (`oklch(L C H [/A])`)
 * - radius em rem entre 0 e 1.5
 * - density ∈ {compact, comfortable, spacious}
 *
 * Validação semântica de contraste WCAG AA roda no service antes de
 * persistir — DTO valida só forma.
 */

import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const THEME_BASE_BRANDS = ['A', 'B', 'C'] as const;
export type ThemeBaseBrand = (typeof THEME_BASE_BRANDS)[number];

export const THEME_DENSITY = ['compact', 'comfortable', 'spacious'] as const;
export type ThemeDensity = (typeof THEME_DENSITY)[number];

// OKLCH literal: `oklch(L C H)` ou `oklch(L C H / A)`. L 0-1, C 0-0.4, H 0-360.
// Espaços/decimais flexíveis. Não validamos os ranges aqui — só a forma,
// porque ranges válidos dependem do gamut alvo e a validação semântica
// roda no service (contraste WCAG).
export const OKLCH_REGEX =
  /^oklch\(\s*[\d.]+\s+[\d.]+\s+[\d.]+(\s*\/\s*[\d.]+)?\s*\)$/;

export class ThemePaletteDto {
  @ApiProperty({ description: 'Cor primária em OKLCH', example: 'oklch(0.22 0.04 250)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'primary deve ser OKLCH válido' })
  primary!: string;

  @ApiProperty({ description: 'Cor de accent em OKLCH', example: 'oklch(0.62 0.16 35)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'accent deve ser OKLCH válido' })
  accent!: string;

  @ApiProperty({ description: 'Cor success em OKLCH', example: 'oklch(0.6 0.13 150)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'success deve ser OKLCH válido' })
  success!: string;

  @ApiProperty({ description: 'Cor warning em OKLCH', example: 'oklch(0.75 0.16 80)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'warning deve ser OKLCH válido' })
  warning!: string;

  @ApiProperty({ description: 'Cor danger em OKLCH', example: 'oklch(0.577 0.245 27.325)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'danger deve ser OKLCH válido' })
  danger!: string;
}

export class ThemeTokensDto {
  @ApiProperty({
    description: 'Brand de origem (referência pra reset e derivações).',
    enum: THEME_BASE_BRANDS,
  })
  @IsIn(THEME_BASE_BRANDS)
  base!: ThemeBaseBrand;

  @ApiProperty({ description: 'Cores no modo light', type: ThemePaletteDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ThemePaletteDto)
  light!: ThemePaletteDto;

  @ApiProperty({ description: 'Cores no modo dark', type: ThemePaletteDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ThemePaletteDto)
  dark!: ThemePaletteDto;

  @ApiProperty({
    description: 'Radius base em rem (0 a 1.5). Tokens sm/md/lg/xl são proporcionais.',
    example: '0.5rem',
  })
  @IsString()
  @Matches(/^(0|1|1\.5|0?\.\d{1,3})rem$/, {
    message: 'radius deve ser entre 0 e 1.5rem',
  })
  radius!: string;

  @ApiPropertyOptional({
    description: 'Densidade visual (afeta spacing). Default: comfortable.',
    enum: THEME_DENSITY,
  })
  @IsOptional()
  @IsIn(THEME_DENSITY)
  density?: ThemeDensity;
}

/**
 * Tipo serializado pra Json field do Prisma — espelha ThemeTokensDto mas
 * sem decoradores (uso em service/repository).
 */
export interface ThemeTokensShape {
  base: ThemeBaseBrand;
  light: { primary: string; accent: string; success: string; warning: string; danger: string };
  dark: { primary: string; accent: string; success: string; warning: string; danger: string };
  radius: string;
  density?: ThemeDensity;
}
