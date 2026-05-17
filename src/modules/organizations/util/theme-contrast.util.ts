/**
 * Sprint S18 Wave 3 — Theme Builder OKLCH PRO (Fase 1 backend)
 *
 * Validacao WCAG AA para pares de cores customizadas. Doc pode pintar
 * qualquer cor, mas se a combinacao resultante for ilegivel (contraste
 * abaixo de 4.5:1 pra texto normal, abaixo de 3:1 pra UI grande),
 * rejeitamos 422.
 *
 * Implementacao pure-math sem dependencia externa. Conversao:
 *   OKLCH -> OKLab (polar to cartesian) -> linear sRGB -> luminance
 *
 * Referencias:
 *   OKLab/OKLCH: https://bottosson.github.io/posts/oklab/
 *   WCAG 2.1: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */

export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3.0;
export const WCAG_AA_UI = 3.0;

/**
 * Parse uma string OKLCH `oklch(L C H)` ou `oklch(L C H / A)` retornando
 * componentes numericos. Alpha ignorado pra fins de contraste.
 */
export function parseOklch(s: string): { l: number; c: number; h: number } {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(\s*\/\s*[\d.]+)?\s*\)$/.exec(s);
  if (!match) throw new Error(`Invalid OKLCH: "${s}"`);
  return {
    l: parseFloat(match[1]),
    c: parseFloat(match[2]),
    h: parseFloat(match[3]),
  };
}

/**
 * OKLCH para linear sRGB (range 0..1, gamut-clipped).
 */
export function oklchToLinearRgb(l: number, c: number, h: number): {
  r: number;
  g: number;
  b: number;
} {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;

  const lc = lp ** 3;
  const mc = mp ** 3;
  const sc = sp ** 3;

  const r = +4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  const g = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  const bch = -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc;

  return {
    r: Math.max(0, Math.min(1, r)),
    g: Math.max(0, Math.min(1, g)),
    b: Math.max(0, Math.min(1, bch)),
  };
}

/**
 * WCAG relative luminance da cor (ja em linear sRGB, range 0..1).
 */
export function relativeLuminance({
  r,
  g,
  b,
}: {
  r: number;
  g: number;
  b: number;
}): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast ratio WCAG entre duas cores (OKLCH strings).
 */
export function contrastRatio(fg: string, bg: string): number {
  const fgParsed = parseOklch(fg);
  const bgParsed = parseOklch(bg);
  const fgRgb = oklchToLinearRgb(fgParsed.l, fgParsed.c, fgParsed.h);
  const bgRgb = oklchToLinearRgb(bgParsed.l, bgParsed.c, bgParsed.h);
  const lFg = relativeLuminance(fgRgb);
  const lBg = relativeLuminance(bgRgb);
  const lighter = Math.max(lFg, lBg);
  const darker = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Valida que todos os pares criticos do tema custom passam WCAG AA.
 * Retorna array de erros (vazio = tudo OK). Service usa isso pra
 * decidir entre 200 (salva) ou 422 (rejeita com lista de falhas).
 *
 * Wave 4.1: expandido de 6 pra 14 checks pra cobrir bg/surface/fg/border
 * e os 5 tokens de sidebar. Pares vindos do escopo expandido sao validados
 * LITERALMENTE (fg vs bg fornecidos pelo Doc) — sem assumir FG_ON_DARK.
 *
 * Compat: pares legacy (Wave 3) continuam usando FG_ON_DARK fixo (tech
 * debt conhecido — Sprint S19). Pares novos NAO sofrem do mesmo problema
 * porque o Doc fornece a cor de fg explicitamente.
 *
 * Os campos de palette expandida (bg/surface/fg/border/sidebar*) sao
 * opcionais aqui pra preservar backward-compat — se faltar, service
 * deve ter chamado `normalizeThemeTokens()` antes pra preencher defaults.
 */
export interface ContrastValidationPalette {
  // Funcionais (sempre obrigatorias)
  primary: string;
  accent: string;
  danger: string;
  // Expandidas Wave 4.1 (opcionais aqui pra backward-compat)
  bg?: string;
  surface?: string;
  fg?: string;
  sidebar?: string;
  sidebarFg?: string;
  sidebarAccent?: string;
  sidebarAccentFg?: string;
}

export function validateThemeContrast(tokens: {
  light: ContrastValidationPalette;
  dark: ContrastValidationPalette;
}): string[] {
  const errors: string[] = [];

  const FG_ON_DARK = 'oklch(0.985 0 0)';
  const SURFACE_LIGHT = 'oklch(1 0 0)';
  const SURFACE_DARK = 'oklch(0.18 0.01 250)';

  // Botões são UI components no WCAG 2.1 (threshold 3:1 pra contraste de
  // fundo). Texto dentro do botão é normalmente bold/semibold em 14pt+,
  // categorizado como "large text" (também 3:1). Por isso usamos WCAG_AA_UI
  // pra todos os pares de botao — é o threshold correto pra componentes
  // interativos, não o 4.5 que é só pra texto pequeno em prose.
  //
  // Pares de TEXTO normal (fg em superficie) usam WCAG_AA_NORMAL_TEXT = 4.5:1.
  // Reference: https://www.w3.org/TR/WCAG21/#non-text-contrast
  const checks: Array<{ name: string; fg: string | undefined; bg: string | undefined; min: number }> = [
    // ─── Legacy (Wave 3) — 6 checks ────────────────────────
    {
      name: 'light.primary vs primary-fg (botao primario)',
      fg: FG_ON_DARK,
      bg: tokens.light.primary,
      min: WCAG_AA_UI,
    },
    {
      name: 'light.accent vs accent-fg (botao accent)',
      fg: FG_ON_DARK,
      bg: tokens.light.accent,
      min: WCAG_AA_UI,
    },
    {
      name: 'light.danger vs surface (badge erro visivel)',
      fg: tokens.light.danger,
      bg: SURFACE_LIGHT,
      min: WCAG_AA_UI,
    },
    {
      name: 'dark.primary vs primary-fg (botao primario no escuro)',
      fg: FG_ON_DARK,
      bg: tokens.dark.primary,
      min: WCAG_AA_UI,
    },
    {
      name: 'dark.accent vs accent-fg (botao accent no escuro)',
      fg: FG_ON_DARK,
      bg: tokens.dark.accent,
      min: WCAG_AA_UI,
    },
    {
      name: 'dark.danger vs surface (badge erro no escuro)',
      fg: tokens.dark.danger,
      bg: SURFACE_DARK,
      min: WCAG_AA_UI,
    },

    // ─── Wave 4.1: estrutura (4 checks) ────────────────────
    {
      name: 'light.fg vs light.bg (texto principal em fundo claro)',
      fg: tokens.light.fg,
      bg: tokens.light.bg,
      min: WCAG_AA_NORMAL_TEXT,
    },
    {
      name: 'light.fg vs light.surface (texto em cards claro)',
      fg: tokens.light.fg,
      bg: tokens.light.surface,
      min: WCAG_AA_NORMAL_TEXT,
    },
    {
      name: 'dark.fg vs dark.bg (texto principal em fundo escuro)',
      fg: tokens.dark.fg,
      bg: tokens.dark.bg,
      min: WCAG_AA_NORMAL_TEXT,
    },
    {
      name: 'dark.fg vs dark.surface (texto em cards escuro)',
      fg: tokens.dark.fg,
      bg: tokens.dark.surface,
      min: WCAG_AA_NORMAL_TEXT,
    },

    // ─── Wave 4.1: sidebar (4 checks) ──────────────────────
    {
      name: 'light.sidebarFg vs light.sidebar (texto sidebar claro)',
      fg: tokens.light.sidebarFg,
      bg: tokens.light.sidebar,
      min: WCAG_AA_NORMAL_TEXT,
    },
    {
      name: 'light.sidebarAccentFg vs light.sidebarAccent (item ativo claro)',
      fg: tokens.light.sidebarAccentFg,
      bg: tokens.light.sidebarAccent,
      min: WCAG_AA_UI,
    },
    {
      name: 'dark.sidebarFg vs dark.sidebar (texto sidebar escuro)',
      fg: tokens.dark.sidebarFg,
      bg: tokens.dark.sidebar,
      min: WCAG_AA_NORMAL_TEXT,
    },
    {
      name: 'dark.sidebarAccentFg vs dark.sidebarAccent (item ativo escuro)',
      fg: tokens.dark.sidebarAccentFg,
      bg: tokens.dark.sidebarAccent,
      min: WCAG_AA_UI,
    },
  ];

  for (const { name, fg, bg, min } of checks) {
    // Pula checks Wave 4.1 quando palette legacy chega sem normalizar
    // (backward-compat absoluta). Service moderno DEVE chamar
    // normalizeThemeTokens() antes pra evitar isso.
    if (!fg || !bg) continue;
    try {
      const ratio = contrastRatio(fg, bg);
      if (ratio < min) {
        errors.push(
          `${name}: contraste ${ratio.toFixed(2)}:1 abaixo do minimo ${min}:1 (WCAG AA)`,
        );
      }
    } catch (err: any) {
      errors.push(`${name}: erro ao calcular (${err.message})`);
    }
  }

  return errors;
}
