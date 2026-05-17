/**
 * Sprint S18 Wave 4.1 — Theme Builder palette EXPANSION (backend Fase 1)
 *
 * Defaults dos 14 tokens × 2 modes pros 3 brands. Valores extraidos
 * literalmente de `chat-bullq-web/src/app/globals.css` blocos
 * `html[data-brand="A|B|C"][data-mode="light|dark"]`.
 *
 * Uso: quando payload legacy (Wave 3/4) chega com palette de 5 cores,
 * service usa `normalizeThemeTokens()` que preenche os 9 campos novos
 * com defaults do brand base antes de validar/persistir.
 *
 * Mantemos ESTES defaults sincronizados com o globals.css do web. Se
 * o web mudar os tokens base de algum brand, ATUALIZAR aqui tambem.
 */

import type {
  LegacyThemeTokensShape,
  ThemeBaseBrand,
  ThemePaletteShape,
  ThemeTokensShape,
} from '../dto/theme-tokens.dto';

interface BrandDefaults {
  light: ThemePaletteShape;
  dark: ThemePaletteShape;
}

/**
 * Cores extraidas de globals.css (linhas 127-405) com WORKAROUND no
 * dark mode pra funcionais primary/accent/danger:
 *
 * O server-side `theme-contrast.util.ts` valida pares funcionais
 * assumindo `primary-fg = FG_ON_DARK` (branco fixo). Mas o app real
 * usa `pickForeground()` (L >= 0.6 -> preto). No globals.css real, brands
 * tem primary CLARO no dark mode (L ~ 0.7) com fg preto.
 *
 * Pra os defaults Wave 4.1 nao serem rejeitados pelo proprio validador,
 * usamos valores Wave 3 do builder (primary dark L=0.4 etc.), que sao
 * mais escuros que os do globals.css mas passam WCAG com FG branco.
 *
 * Tokens NAO funcionais (bg/surface/fg/border/sidebar*) vem direto do
 * globals.css real — eles sao validados com pares LITERAIS (fg vs bg
 * fornecidos) e nao sofrem do tech debt.
 *
 * Fix correto (server usar pickForeground dinamico) fica pra S19.
 */
export const BRAND_PALETTE_DEFAULTS: Record<ThemeBaseBrand, BrandDefaults> = {
  A: {
    light: {
      // Funcionais (mesmas do BRAND_TOKEN_DEFAULTS Wave 3 do builder)
      primary: 'oklch(0.22 0.04 250)',
      accent: 'oklch(0.45 0.18 35)',
      success: 'oklch(0.5 0.15 150)',
      warning: 'oklch(0.55 0.18 80)',
      danger: 'oklch(0.5 0.22 27)',
      // Estrutura (do globals.css real — pares literais nao sofrem tech debt)
      bg: 'oklch(0.97 0.003 30)',
      surface: 'oklch(1 0 0)',
      fg: 'oklch(0.18 0.02 250)',
      border: 'oklch(0.9 0.008 30)',
      // Sidebar
      sidebar: 'oklch(0.985 0.003 30)',
      sidebarFg: 'oklch(0.18 0.02 250)',
      sidebarBorder: 'oklch(0.9 0.008 30)',
      sidebarAccent: 'oklch(0.94 0.04 35)',
      sidebarAccentFg: 'oklch(0.22 0.04 250)',
    },
    dark: {
      // Funcionais com workaround (L baixo pra passar WCAG vs FG branco fixo)
      primary: 'oklch(0.4 0.08 250)',
      accent: 'oklch(0.5 0.16 35)',
      success: 'oklch(0.55 0.15 150)',
      warning: 'oklch(0.62 0.18 80)',
      danger: 'oklch(0.62 0.21 27)',
      // Estrutura (real globals)
      bg: 'oklch(0.16 0.012 250)',
      surface: 'oklch(0.22 0.015 250)',
      fg: 'oklch(0.97 0.003 30)',
      border: 'oklch(0.3 0.015 250)',
      sidebar: 'oklch(0.18 0.012 250)',
      sidebarFg: 'oklch(0.97 0.003 30)',
      sidebarBorder: 'oklch(0.3 0.015 250)',
      sidebarAccent: 'oklch(0.32 0.06 35)',
      sidebarAccentFg: 'oklch(0.97 0.003 30)',
    },
  },
  B: {
    light: {
      primary: 'oklch(0.45 0.2 145)',
      accent: 'oklch(0.45 0.18 220)',
      success: 'oklch(0.5 0.15 150)',
      warning: 'oklch(0.55 0.18 80)',
      danger: 'oklch(0.5 0.22 27)',
      bg: 'oklch(0.99 0.003 240)',
      surface: 'oklch(1 0 0)',
      fg: 'oklch(0.18 0.01 240)',
      border: 'oklch(0.92 0.005 240)',
      sidebar: 'oklch(0.985 0.003 240)',
      sidebarFg: 'oklch(0.18 0.01 240)',
      sidebarBorder: 'oklch(0.92 0.005 240)',
      sidebarAccent: 'oklch(0.95 0.06 145)',
      sidebarAccentFg: 'oklch(0.32 0.18 145)',
    },
    dark: {
      primary: 'oklch(0.5 0.2 145)',
      accent: 'oklch(0.5 0.18 220)',
      success: 'oklch(0.55 0.15 150)',
      warning: 'oklch(0.62 0.18 80)',
      danger: 'oklch(0.62 0.21 27)',
      bg: 'oklch(0.15 0.01 240)',
      surface: 'oklch(0.21 0.013 240)',
      fg: 'oklch(0.97 0.003 240)',
      border: 'oklch(0.3 0.012 240)',
      sidebar: 'oklch(0.17 0.01 240)',
      sidebarFg: 'oklch(0.97 0.003 240)',
      sidebarBorder: 'oklch(0.3 0.012 240)',
      sidebarAccent: 'oklch(0.28 0.05 145)',
      sidebarAccentFg: 'oklch(0.97 0.003 240)',
    },
  },
  C: {
    light: {
      primary: 'oklch(0.22 0 0)',
      accent: 'oklch(0.5 0.2 22)',
      success: 'oklch(0.5 0.15 150)',
      warning: 'oklch(0.55 0.18 80)',
      danger: 'oklch(0.5 0.22 27)',
      bg: 'oklch(0.99 0 0)',
      surface: 'oklch(1 0 0)',
      fg: 'oklch(0.18 0 0)',
      border: 'oklch(0.92 0 0)',
      sidebar: 'oklch(0.99 0 0)',
      sidebarFg: 'oklch(0.18 0 0)',
      sidebarBorder: 'oklch(0.92 0 0)',
      sidebarAccent: 'oklch(0.96 0.04 22)',
      sidebarAccentFg: 'oklch(0.22 0 0)',
    },
    dark: {
      primary: 'oklch(0.3 0 0)',
      accent: 'oklch(0.5 0.2 22)',
      success: 'oklch(0.55 0.15 150)',
      warning: 'oklch(0.62 0.18 80)',
      danger: 'oklch(0.62 0.21 27)',
      bg: 'oklch(0.14 0 0)',
      surface: 'oklch(0.2 0 0)',
      fg: 'oklch(0.97 0 0)',
      border: 'oklch(0.28 0 0)',
      sidebar: 'oklch(0.16 0 0)',
      sidebarFg: 'oklch(0.97 0 0)',
      sidebarBorder: 'oklch(0.28 0 0)',
      sidebarAccent: 'oklch(0.3 0.08 22)',
      sidebarAccentFg: 'oklch(0.97 0 0)',
    },
  },
};

/**
 * Type guard que detecta payload legacy (Wave 3/4) — palette so com
 * 5 cores funcionais, sem os 9 novos da Wave 4.1.
 */
export function isLegacyPalette(palette: any): boolean {
  if (!palette || typeof palette !== 'object') return false;
  // Legacy se tem as 5 funcionais MAS faltam as 9 novas
  const hasFunctional =
    typeof palette.primary === 'string' &&
    typeof palette.accent === 'string' &&
    typeof palette.success === 'string' &&
    typeof palette.warning === 'string' &&
    typeof palette.danger === 'string';
  if (!hasFunctional) return false;
  const hasExpanded =
    typeof palette.bg === 'string' &&
    typeof palette.surface === 'string' &&
    typeof palette.fg === 'string' &&
    typeof palette.border === 'string' &&
    typeof palette.sidebar === 'string' &&
    typeof palette.sidebarFg === 'string' &&
    typeof palette.sidebarBorder === 'string' &&
    typeof palette.sidebarAccent === 'string' &&
    typeof palette.sidebarAccentFg === 'string';
  return !hasExpanded;
}

/**
 * Normaliza tokens (legacy ou expanded) pra shape canonico Wave 4.1.
 * Se payload tem so 5 cores, preenche os 9 novos com defaults do brand
 * `base`. Se ja vem expanded, retorna como esta (override de Doc tem
 * precedencia sobre defaults).
 *
 * Usado em service ANTES de chamar validateThemeContrast.
 */
export function normalizeThemeTokens(
  tokens: ThemeTokensShape | LegacyThemeTokensShape | any,
): ThemeTokensShape {
  const base: ThemeBaseBrand = tokens.base in BRAND_PALETTE_DEFAULTS ? tokens.base : 'A';
  const defaults = BRAND_PALETTE_DEFAULTS[base];

  const normalizePalette = (
    palette: any,
    fallback: ThemePaletteShape,
  ): ThemePaletteShape => ({
    primary: palette?.primary ?? fallback.primary,
    accent: palette?.accent ?? fallback.accent,
    success: palette?.success ?? fallback.success,
    warning: palette?.warning ?? fallback.warning,
    danger: palette?.danger ?? fallback.danger,
    bg: palette?.bg ?? fallback.bg,
    surface: palette?.surface ?? fallback.surface,
    fg: palette?.fg ?? fallback.fg,
    border: palette?.border ?? fallback.border,
    sidebar: palette?.sidebar ?? fallback.sidebar,
    sidebarFg: palette?.sidebarFg ?? fallback.sidebarFg,
    sidebarBorder: palette?.sidebarBorder ?? fallback.sidebarBorder,
    sidebarAccent: palette?.sidebarAccent ?? fallback.sidebarAccent,
    sidebarAccentFg: palette?.sidebarAccentFg ?? fallback.sidebarAccentFg,
  });

  return {
    base,
    light: normalizePalette(tokens.light, defaults.light),
    dark: normalizePalette(tokens.dark, defaults.dark),
    radius: tokens.radius ?? '0.5rem',
    density: tokens.density,
  };
}
