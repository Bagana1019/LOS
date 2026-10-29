import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadFontBytes } from './fonts';
import { loadMeasureFonts } from './pdf-inspect';

describe('loadFontBytes', () => {
  it('DejaVu Sans / Bold TrueType bytes-ийг уншина (sfnt header 0x00010000)', async () => {
    const [regular, bold] = await Promise.all([loadFontBytes('regular'), loadFontBytes('bold')]);
    for (const bytes of [regular, bold]) {
      expect(bytes.length).toBeGreaterThan(100_000);
      expect(Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0)).toBe(0x00010000);
    }
    expect(Buffer.from(regular).equals(Buffer.from(bold))).toBe(false);
  });

  it('нэг удаа уншиж cache-лэнэ: давтан/зэрэгцээ дуудлага ижил promise буцаана', async () => {
    const first = loadFontBytes('regular');
    expect(loadFontBytes('regular')).toBe(first);
    expect(await first).toBe(await loadFontBytes('regular'));
  });

  it('монгол кирилл Ө ө Ү ү болон № · — тэмдэгтүүдийг шрифт агуулна', async () => {
    const { regular, bold } = await loadMeasureFonts();
    for (const font of [regular, bold]) {
      const chars = new Set(font.getCharacterSet());
      for (const ch of 'ӨөҮү№·—ТЕСТ') expect(chars.has(ch.codePointAt(0) as number)).toBe(true);
    }
  });
});

describe('loadFontBytes (уншилтын алдаа)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it('уншилт амжилтгүй бол алдааг cache-д үлдээхгүй — дараагийн дуудлага дахин оролдоно', async () => {
    const readFile = vi.fn().mockRejectedValueOnce(new Error('EIO')).mockResolvedValue(Buffer.from('font-bytes'));
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({ readFile }));
    const { loadFontBytes: fresh } = await vi.importActual<typeof import('./fonts')>('./fonts');

    await expect(fresh('regular')).rejects.toThrow('EIO');
    await expect(fresh('regular')).resolves.toEqual(Buffer.from('font-bytes'));
    await fresh('regular');
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
