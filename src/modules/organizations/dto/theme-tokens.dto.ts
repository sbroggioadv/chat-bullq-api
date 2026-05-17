/**
 * Sprint S18 Wave 4.1 — Theme Builder palette EXPANSION (backend Fase 1)
 *
 * Shape do `Organization.themeTokens`. Wave 4.1 expande de 5 pra 14 cores
 * customizaveis por mode, organizadas em 3 grupos:
 *
 *   - Funcionais (5): primary, accent, success, warning, danger
 *   - Estrutura  (4): bg, surface, fg, border
 *   - Sidebar    (5): sidebar, sidebarFg, sidebarBorder, sidebarAccent,
 *                     sidebarAccentFg
 *
 * Backward compat: orgs com payload de 5 cores ainda funciona via
 * `normalizeThemeTokens()` no service (completa os 9 faltantes com
 * defaults do brand base antes de validar).
 *
 * Validacao:
 *   - `base` ∈ {A, B, C} — usada pra Reset e como defaults pros tokens
 *     novos quando legacy payload chega
 *   - Cores em OKLCH literal (`oklch(L C H [/A])`)
 *   - radius em rem entre 0 e 1.5
 *   - density ∈ {compact, comfortable, spacious}
 *
 * Validacao semantica de contraste WCAG AA roda no service antes de
 * persistir — DTO valida so forma.
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

const oklchMatch = { message: 'deve ser OKLCH valido (formato oklch(L C H))' };

export class ThemePaletteDto {
  // ─── Funcionais ─────────────────────────────────────────────

  @ApiProperty({ description: 'Cor primária em OKLCH', example: 'oklch(0.22 0.04 250)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'primary ' + oklchMatch.message })
  primary!: string;

  @ApiProperty({ description: 'Cor de accent em OKLCH', example: 'oklch(0.62 0.16 35)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'accent ' + oklchMatch.message })
  accent!: string;

  @ApiProperty({ description: 'Cor success em OKLCH', example: 'oklch(0.6 0.13 150)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'success ' + oklchMatch.message })
  success!: string;

  @ApiProperty({ description: 'Cor warning em OKLCH', example: 'oklch(0.75 0.16 80)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'warning ' + oklchMatch.message })
  warning!: string;

  @ApiProperty({ description: 'Cor danger em OKLCH', example: 'oklch(0.577 0.245 27.325)' })
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'danger ' + oklchMatch.message })
  danger!: string;

  // ─── Estrutura geral (Wave 4.1) ─────────────────────────────
  // Sao OPCIONAIS no DTO porque payloads legacy (Wave 3/4 só com 5 cores)
  // ainda chegam. Service preenche defaults do brand base antes de validar.

  @ApiPropertyOptional({ description: 'Fundo geral da pagina em OKLCH (Wave 4.1)' })
  @IsOptional()
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'bg ' + oklchMatch.message })
  bg?: string;

  @ApiPropertyOptional({ description: 'Superficie (cartoes/paineis) em OKLCH (Wave 4.1)' })
  @IsOptional()
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'surface ' + oklchMatch.message })
  surface?: string;

  @ApiPropertyOptional({ description: 'Texto principal em OKLCH (Wave 4.1)' })
  @IsOptional()
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'fg ' + oklchMatch.message })
  fg?: string;

  @ApiPropertyOptional({ description: 'Bordas / separadores em OKLCH (Wave 4.1)' })
  @IsOptional()
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'border ' + oklchMatch.message })
  border?: string;

  // ─── Sidebar (Wave 4.1) ─────────────────────────────────────

  @ApiPropertyOptional({ description: 'Fundo da barra lateral em OKLCH (Wave 4.1)' })
  @IsOptional()
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'sidebar ' + oklchMatch.message })
  sidebar?: string;

  @ApiPropertyOptional({ description: 'Texto/icones da barra lateral em OKLCH (Wave 4.1)' })
  @IsOptional()
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'sidebarFg ' + oklchMatch.message })
  sidebarFg?: string;

  @ApiPropertyOptional({ description: 'Separador sidebar/content em OKLCH (Wave 4.1)' })
  @IsOptional()
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'sidebarBorder ' + oklchMatch.message })
  sidebarBorder?: string;

  @ApiPropertyOptional({ description: 'Item ativo/hover na sidebar em OKLCH (Wave 4.1)' })
  @IsOptional()
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'sidebarAccent ' + oklchMatch.message })
  sidebarAccent?: string;

  @ApiPropertyOptional({ description: 'Texto do item ativo da sidebar em OKLCH (Wave 4.1)' })
  @IsOptional()
  @IsString()
  @Matches(OKLCH_REGEX, { message: 'sidebarAccentFg ' + oklchMatch.message })
  sidebarAccentFg?: string;
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
 * Shape canonico (apos normalizacao). Todos os 14 campos garantidos
 * pelo service. Util em todos os pontos pos-`normalizeThemeTokens()`.
 */
export interface ThemePaletteShape {
  // Funcionais
  primary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  // Estrutura
  bg: string;
  surface: string;
  fg: string;
  border: string;
  // Sidebar
  sidebar: string;
  sidebarFg: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentFg: string;
}

export interface ThemeTokensShape {
  base: ThemeBaseBrand;
  light: ThemePaletteShape;
  dark: ThemePaletteShape;
  radius: string;
  density?: ThemeDensity;
}

/**
 * Shape legacy (Wave 3/4) — palette só com 5 cores funcionais. Service
 * trata via `normalizeThemeTokens()` antes de validar.
 */
export interface LegacyThemePaletteShape {
  primary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

export interface LegacyThemeTokensShape {
  base: ThemeBaseBrand;
  light: LegacyThemePaletteShape;
  dark: LegacyThemePaletteShape;
  radius: string;
  density?: ThemeDensity;
}
