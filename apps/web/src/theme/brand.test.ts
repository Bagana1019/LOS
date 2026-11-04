import { describe, expect, it } from 'vitest';
import { contrastRatio, MIN_TEXT_CONTRAST } from '../features/merchant/tag-tones';
import { antdTheme, brand, brandCssVars } from './brand';

// Брэндбүүк §06–07: HEX утгууд + хүртээмж (текст ≥ 4.5:1).
describe('brand tokens (Lignum LOS брэндбүүк v1.0)', () => {
  it('name and core HEX values match the brandbook', () => {
    expect(brand.name).toBe('Lignum LOS');
    expect(brand.colors).toMatchObject({ forest: '#0A3A2A', mint: '#10B981', surface0: '#F8FAFC', forestMuted: '#2F6B57', mintStrong: '#059669', ink: '#0F172A', onMint: '#042F22' });
  });
  it('text pairs meet 4.5:1', () => {
    const { colors: c, status } = brand;
    expect(contrastRatio(c.onMint, c.mint)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST); // минт дээр #042F22
    expect(contrastRatio('#FFFFFF', c.forest)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST); // ойн ногоон дээр цагаан
    expect(contrastRatio(c.forestMuted, c.surface1)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(c.ink, c.surface0)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    for (const [k, s] of Object.entries(status)) expect(contrastRatio(s.fg, s.bg), k).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
  it('mint is not used as text on white (brandbook: 2.6:1)', () => {
    expect(contrastRatio(brand.colors.mint, '#FFFFFF')).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(antdTheme.token?.colorLink).toBe(brand.colors.forestMuted);
  });
  it('antd theme and CSS variables are derived from the same tokens', () => {
    expect(antdTheme.token?.colorPrimary).toBe(brand.colors.mint);
    expect(antdTheme.components?.Layout?.siderBg).toBe(brand.colors.forest);
    expect(antdTheme.components?.Button?.primaryColor).toBe(brand.colors.onMint);
    const vars = brandCssVars as Record<string, string>;
    expect(vars['--brand-forest']).toBe(brand.colors.forest);
    expect(vars['--brand-radius-control']).toBe('10px');
    expect(vars['--brand-radius-card']).toBe('14px');
  });
});
