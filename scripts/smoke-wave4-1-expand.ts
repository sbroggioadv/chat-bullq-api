/**
 * Sprint S18 Wave 4.1 — smoke matematico do validador expandido.
 *
 * Roda sem Prisma, sem rede. Valida:
 *  1. Tokens validos completos (14 campos × 2 modes) -> [] erros
 *  2. Tokens com sidebarFg == sidebar -> erro de contraste
 *  3. Tokens com fg == bg -> erro de contraste
 *  4. normalizeThemeTokens preenche campos faltantes com defaults do brand
 *  5. normalizeThemeTokens preserva valores explicitos sobre defaults
 *  6. isLegacyPalette detecta payloads pre-Wave 4.1
 *  7. Brand B + C defaults passam WCAG AA
 *  8. Override de sidebarAccentFg muito proximo de sidebarAccent eh detectado
 */

import { validateThemeContrast } from '../src/modules/organizations/util/theme-contrast.util';
import {
  BRAND_PALETTE_DEFAULTS,
  normalizeThemeTokens,
  isLegacyPalette,
} from '../src/modules/organizations/util/theme-defaults.util';

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass += 1;
  } catch (err: any) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    fail += 1;
  }
}

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log('Smoke Wave 4.1 — validator expansion + normalize');
console.log('────────────────────────────────────────────────');

test('Brand A defaults completos passam WCAG', () => {
  const errs = validateThemeContrast({
    light: BRAND_PALETTE_DEFAULTS.A.light,
    dark: BRAND_PALETTE_DEFAULTS.A.dark,
  });
  expect(errs.length === 0, `Brand A deveria passar, erros: ${JSON.stringify(errs)}`);
});

test('Brand B defaults completos passam WCAG', () => {
  const errs = validateThemeContrast({
    light: BRAND_PALETTE_DEFAULTS.B.light,
    dark: BRAND_PALETTE_DEFAULTS.B.dark,
  });
  expect(errs.length === 0, `Brand B deveria passar, erros: ${JSON.stringify(errs)}`);
});

test('Brand C defaults completos passam WCAG', () => {
  const errs = validateThemeContrast({
    light: BRAND_PALETTE_DEFAULTS.C.light,
    dark: BRAND_PALETTE_DEFAULTS.C.dark,
  });
  expect(errs.length === 0, `Brand C deveria passar, erros: ${JSON.stringify(errs)}`);
});

test('fg == bg dispara erro de contraste no light', () => {
  const broken = {
    ...BRAND_PALETTE_DEFAULTS.A.light,
    fg: 'oklch(0.97 0.003 30)', // mesma cor do bg (default A light)
    bg: 'oklch(0.97 0.003 30)',
  };
  const errs = validateThemeContrast({
    light: broken,
    dark: BRAND_PALETTE_DEFAULTS.A.dark,
  });
  expect(errs.length > 0, 'Deveria ter erros');
  expect(
    errs.some((e) => e.includes('light.fg vs light.bg')),
    'Deveria mencionar light.fg vs light.bg',
  );
});

test('sidebarFg == sidebar dispara erro de contraste', () => {
  const broken = {
    ...BRAND_PALETTE_DEFAULTS.A.light,
    sidebarFg: 'oklch(0.985 0.003 30)',
    sidebar: 'oklch(0.985 0.003 30)',
  };
  const errs = validateThemeContrast({
    light: broken,
    dark: BRAND_PALETTE_DEFAULTS.A.dark,
  });
  expect(
    errs.some((e) => e.includes('sidebarFg vs')),
    `Deveria mencionar sidebarFg, erros: ${JSON.stringify(errs)}`,
  );
});

test('sidebarAccentFg igual ao sidebarAccent dispara erro', () => {
  const broken = {
    ...BRAND_PALETTE_DEFAULTS.A.light,
    sidebarAccent: 'oklch(0.5 0.1 250)',
    sidebarAccentFg: 'oklch(0.5 0.1 250)',
  };
  const errs = validateThemeContrast({
    light: broken,
    dark: BRAND_PALETTE_DEFAULTS.A.dark,
  });
  expect(
    errs.some((e) => e.includes('sidebarAccentFg vs')),
    `Deveria mencionar sidebarAccentFg, erros: ${JSON.stringify(errs)}`,
  );
});

test('isLegacyPalette detecta payload Wave 3 (5 cores)', () => {
  const legacy = {
    primary: 'oklch(0.22 0.04 250)',
    accent: 'oklch(0.5 0.16 35)',
    success: 'oklch(0.5 0.13 150)',
    warning: 'oklch(0.55 0.16 80)',
    danger: 'oklch(0.5 0.22 27)',
  };
  expect(isLegacyPalette(legacy) === true, 'Deveria ser legacy');
});

test('isLegacyPalette retorna false pra payload Wave 4.1 (14 cores)', () => {
  expect(
    isLegacyPalette(BRAND_PALETTE_DEFAULTS.A.light) === false,
    'Deveria nao ser legacy',
  );
});

test('normalizeThemeTokens preenche campos faltantes com defaults do brand A', () => {
  const legacyTokens = {
    base: 'A' as const,
    light: {
      primary: 'oklch(0.3 0.04 250)',
      accent: 'oklch(0.5 0.16 35)',
      success: 'oklch(0.5 0.13 150)',
      warning: 'oklch(0.55 0.16 80)',
      danger: 'oklch(0.5 0.22 27)',
    },
    dark: {
      primary: 'oklch(0.4 0.04 250)',
      accent: 'oklch(0.55 0.16 35)',
      success: 'oklch(0.55 0.13 150)',
      warning: 'oklch(0.6 0.16 80)',
      danger: 'oklch(0.6 0.22 27)',
    },
    radius: '0.5rem',
    density: 'comfortable' as const,
  };
  const normalized = normalizeThemeTokens(legacyTokens);
  expect(
    normalized.light.primary === 'oklch(0.3 0.04 250)',
    'primary explicito deve sobreviver',
  );
  expect(
    normalized.light.bg === BRAND_PALETTE_DEFAULTS.A.light.bg,
    `bg deveria vir do default A, foi: ${normalized.light.bg}`,
  );
  expect(
    normalized.light.sidebar === BRAND_PALETTE_DEFAULTS.A.light.sidebar,
    'sidebar deveria vir do default A',
  );
  expect(
    normalized.dark.sidebarAccentFg === BRAND_PALETTE_DEFAULTS.A.dark.sidebarAccentFg,
    'sidebarAccentFg dark deveria vir do default A dark',
  );
});

test('normalizeThemeTokens preserva valores explicitos sobre defaults', () => {
  const customSidebar = 'oklch(0.5 0.3 145)'; // verde fluo
  const tokens = {
    base: 'A' as const,
    light: {
      primary: 'oklch(0.3 0.04 250)',
      accent: 'oklch(0.5 0.16 35)',
      success: 'oklch(0.5 0.13 150)',
      warning: 'oklch(0.55 0.16 80)',
      danger: 'oklch(0.5 0.22 27)',
      sidebar: customSidebar,
    },
    dark: BRAND_PALETTE_DEFAULTS.A.dark,
    radius: '0.5rem',
  };
  const normalized = normalizeThemeTokens(tokens);
  expect(
    normalized.light.sidebar === customSidebar,
    'sidebar explicito deve sobreviver',
  );
});

test('normalizeThemeTokens fallback pra brand A quando base invalido', () => {
  const tokens = { base: 'INVALID' as any, light: {}, dark: {}, radius: '0.5rem' };
  const normalized = normalizeThemeTokens(tokens);
  expect(normalized.base === 'A', 'base deveria virar A');
  expect(
    normalized.light.bg === BRAND_PALETTE_DEFAULTS.A.light.bg,
    'bg deveria vir de A',
  );
});

test('Sidebar verde fluo + sidebarAccentFg branco passa WCAG', () => {
  // simula caso real do Doc: Doc pinta sidebar verde fluo, accent-fg branco
  const tokens = {
    ...BRAND_PALETTE_DEFAULTS.A.light,
    sidebar: 'oklch(0.5 0.25 145)', // verde escuro saturado
    sidebarFg: 'oklch(0.985 0 0)', // branco
    sidebarAccent: 'oklch(0.3 0.2 145)', // verde mais escuro
    sidebarAccentFg: 'oklch(0.985 0 0)', // branco
  };
  const errs = validateThemeContrast({
    light: tokens,
    dark: BRAND_PALETTE_DEFAULTS.A.dark,
  });
  // primary/accent/danger continuam validos (nao mexemos), sidebar tambem
  expect(errs.length === 0, `Deveria passar, erros: ${JSON.stringify(errs)}`);
});

console.log('────────────────────────────────────────────────');
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
