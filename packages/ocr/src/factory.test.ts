import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createOcrProvider, OCR_ENGINES } from './factory';
import { MockOcrProvider } from './providers/mock.provider';
import { TesseractOcrProvider } from './providers/tesseract.provider';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);

describe('createOcrProvider: INTEGRATION_MODE', () => {
  it('тохируулаагүй/хоосон үед mock (анхдагч)', () => {
    expect(createOcrProvider({})).toBeInstanceOf(MockOcrProvider);
    expect(createOcrProvider({ INTEGRATION_MODE: '' })).toBeInstanceOf(MockOcrProvider);
    expect(createOcrProvider({ INTEGRATION_MODE: '  ' })).toBeInstanceOf(MockOcrProvider);
  });

  it("'mock' ба 'real' — том/жижиг үсэг, зайг тоохгүй", () => {
    expect(createOcrProvider({ INTEGRATION_MODE: ' MOCK ' })).toBeInstanceOf(MockOcrProvider);
    expect(createOcrProvider({ INTEGRATION_MODE: 'Real' })).toBeInstanceOf(TesseractOcrProvider);
  });

  it("үл мэдэгдэх горим → тодорхой Error (чимээгүй mock руу унахгүй)", () => {
    expect(() => createOcrProvider({ INTEGRATION_MODE: 'prod' })).toThrow(/INTEGRATION_MODE/);
    expect(() => createOcrProvider({ INTEGRATION_MODE: 'true' })).toThrow(/mock.*real/);
  });

  it('process.env-ийг анхдагчаар ашиглана', () => {
    const saved = process.env.INTEGRATION_MODE;
    try {
      process.env.INTEGRATION_MODE = 'real';
      expect(createOcrProvider()).toBeInstanceOf(TesseractOcrProvider);
    } finally {
      if (saved === undefined) delete process.env.INTEGRATION_MODE;
      else process.env.INTEGRATION_MODE = saved;
    }
  });
});

describe('createOcrProvider: OCR_ENGINE', () => {
  it("real үед анхдагч 'tesseract'; mock үед OCR_ENGINE үл хамаарна", () => {
    expect(createOcrProvider({ INTEGRATION_MODE: 'real' }).name).toBe('tesseract');
    expect(createOcrProvider({ INTEGRATION_MODE: 'real', OCR_ENGINE: 'Tesseract' }).name).toBe('tesseract');
    expect(createOcrProvider({ INTEGRATION_MODE: 'mock', OCR_ENGINE: 'whatever' })).toBeInstanceOf(MockOcrProvider);
  });

  it('үл мэдэгдэх хөдөлгүүр → Error (боломжит жагсаалттай); prototype түлхүүрүүдийг хүлээн авахгүй', () => {
    expect(() => createOcrProvider({ INTEGRATION_MODE: 'real', OCR_ENGINE: 'google' })).toThrow(/google.*tesseract/);
    for (const engine of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(() => createOcrProvider({ INTEGRATION_MODE: 'real', OCR_ENGINE: engine })).toThrow(/OCR_ENGINE/);
    }
    expect(() => createOcrProvider({ INTEGRATION_MODE: 'real', OCR_ENGINE: 'x'.repeat(500) })).toThrow(/OCR_ENGINE/);
  });

  it('OCR_ENGINES бүртгэлд шинэ хөдөлгүүр нэмэх боломжтой (өргөтгөл)', () => {
    const fake = new MockOcrProvider();
    (OCR_ENGINES as Record<string, () => MockOcrProvider>).cloud = () => fake;
    try {
      expect(createOcrProvider({ INTEGRATION_MODE: 'real', OCR_ENGINE: 'cloud' })).toBe(fake);
    } finally {
      delete (OCR_ENGINES as Record<string, unknown>).cloud;
    }
  });
});

describe('createOcrProvider: тоон/текст env-ийн шалгалт', () => {
  const real = (extra: Record<string, string>) => createOcrProvider({ INTEGRATION_MODE: 'real', ...extra });

  it.each([
    ['OCR_PSM', ['abc', '14', '-1', '6.5', '1e1', '0x6']],
    ['OCR_DPI', ['50', '2401', 'x']],
    ['OCR_TIMEOUT_MS', ['0', '600001', '1.5', '']],
    ['OCR_MAX_PAGES', ['0', '501', '-3']],
    ['OCR_MAX_INPUT_BYTES', ['0', 'many']],
  ])('%s: буруу утгад хувьсагчийн нэрийг заасан Error', (name, values) => {
    for (const v of values) {
      if (v === '') continue; // хоосон = тохируулаагүй
      expect(() => real({ [name]: v })).toThrow(new RegExp(name));
    }
  });

  it('хоосон/зайтай утга = тохируулаагүй (анхдагч)', () => {
    expect(() => real({ OCR_PSM: '', OCR_DPI: ' ', OCR_LANGUAGES: '' })).not.toThrow();
  });

  it('OCR_LANGUAGES: "mon+eng", "mon,eng" зөв; injection, том үсэг, хэт богино → Error', () => {
    expect(() => real({ OCR_LANGUAGES: 'mon+eng' })).not.toThrow();
    expect(() => real({ OCR_LANGUAGES: 'mon, eng' })).not.toThrow();
    for (const bad of ['mon+--oem', 'MON', 'mo', 'mon+', '-l', 'mon eng']) expect(() => real({ OCR_LANGUAGES: bad })).toThrow(/OCR_LANGUAGES/);
  });

  it('TESSERACT_BIN / PDFTOPPM_BIN: "-" эхэлсэн утга (аргумент шиг харагдах) болон NUL-ийг татгалзана', () => {
    expect(() => real({ TESSERACT_BIN: '--version' })).toThrow(/TESSERACT_BIN/);
    expect(() => real({ PDFTOPPM_BIN: '-h' })).toThrow(/PDFTOPPM_BIN/);
    expect(() => real({ TESSERACT_BIN: 'a\0b' })).toThrow(/TESSERACT_BIN/);
    expect(() => real({ TESSERACT_BIN: '/usr/local/bin/tesseract' })).not.toThrow();
  });
});

describe('createOcrProvider: env → tesseract дуудлага (жинхэнэ spawn, хуурамч tesseract скриптээр)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'los-ocr-factory-test-'));
  const script = join(dir, 'fake-tesseract');
  writeFileSync(
    script,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('tesseract 9.9.9'); process.exit(0); }
const H = 'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext';
console.log(H);
console.log(['5', 1, 1, 1, 1, 1, 0, 0, 10, 10, 90, a.slice(1).join('_')].join('\\t'));
`,
  );
  chmodSync(script, 0o755);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('TESSERACT_BIN, OCR_LANGUAGES, OCR_PSM, OCR_DPI бодитоор дэд процесст дамжина', async () => {
    const p = createOcrProvider({ INTEGRATION_MODE: 'real', TESSERACT_BIN: script, OCR_LANGUAGES: 'eng', OCR_PSM: '4', OCR_DPI: '400', PATH: process.env.PATH });
    const r = await p.recognize({ content: PNG, mimeType: 'image/png' });
    expect(r.text).toBe('stdout_-l_eng_--psm_4_--dpi_400_tsv');
    expect(r.engineVersion).toBe('9.9.9');
  });

  it('OCR_TIMEOUT_MS дамжина: удаан tesseract → TIMEOUT', async () => {
    const slow = join(dir, 'slow-tesseract');
    writeFileSync(slow, '#!/usr/bin/env node\nif (process.argv[2] !== "--version") setTimeout(() => {}, 30000); else console.log("tesseract 1");\n');
    chmodSync(slow, 0o755);
    const p = createOcrProvider({ INTEGRATION_MODE: 'real', TESSERACT_BIN: slow, OCR_TIMEOUT_MS: '400', PATH: process.env.PATH });
    await expect(p.recognize({ content: PNG, mimeType: 'image/png' })).rejects.toMatchObject({ name: 'OcrError', code: 'TIMEOUT' });
  });

  it('байхгүй TESSERACT_BIN → ENGINE_UNAVAILABLE', async () => {
    const p = createOcrProvider({ INTEGRATION_MODE: 'real', TESSERACT_BIN: join(dir, 'does-not-exist'), PATH: process.env.PATH });
    await expect(p.recognize({ content: PNG, mimeType: 'image/png' })).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
});
