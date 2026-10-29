import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OcrError, type OcrInput } from '../types';
import type { CommandRunner, RunOptions, RunResult } from './runner';
import { scrubDiagnostic, TesseractOcrProvider, type TesseractOcrProviderOptions } from './tesseract.provider';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-image-bytes')]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.7\nfake');
const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const word = (text: string, conf = 90, n = 1) => ['5', '1', '1', '1', '1', String(n), '10', '10', '50', '20', String(conf), text].join('\t');
const tsv = (...words: string[]) => [HEADER, ['1', '1', '0', '0', '0', '0', '0', '0', '800', '600', '-1', ''].join('\t'), ...words].join('\n');
const ok = (stdout = '', extra: Partial<RunResult> = {}): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, stdoutTruncated: false, ...extra });
const VERSION_OUT = ok('tesseract 5.3.4\n leptonica-1.82.0\n');

interface Call {
  cmd: string;
  args: string[];
  opts: RunOptions;
}
type Handler = (call: Call) => RunResult | Promise<RunResult>;

function harness(handler: Handler, options: TesseractOcrProviderOptions = {}) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (cmd, args, opts) => {
    const call = { cmd, args: [...args], opts };
    calls.push(call);
    if (args[0] === '--version') return VERSION_OUT;
    return handler(call);
  };
  const clock = { now: 1_000 };
  const provider = new TesseractOcrProvider({ runner, clock: () => clock.now, ...options });
  return { provider, calls, clock, work: () => calls.filter((c) => c.args[0] !== '--version') };
}

const png = (extra: Partial<OcrInput> = {}): OcrInput => ({ content: PNG, mimeType: 'image/png', ...extra });
const fail = async (p: Promise<unknown>): Promise<OcrError> => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(OcrError);
  return e as OcrError;
};
const spawnError = (code: string) => Object.assign(new Error(`spawn ${code}`), { code });

describe('TesseractOcrProvider: зураг', () => {
  it('зөв аргументтай дуудаж (shell-гүй args массив), TSV-ийг OcrResult болгоно', async () => {
    const { provider, work, clock } = harness((_c) => {
      clock.now += 250;
      return ok(tsv(word('Овог', 95), word('Дорж', 85, 2)));
    });
    const r = await provider.recognize(png({ fileName: '../../etc/passwd.png' }));
    const [call] = work();
    expect(call.cmd).toBe('tesseract');
    const [file, ...rest] = call.args;
    expect(rest).toEqual(['stdout', '-l', 'mon+eng', '--psm', '6', '--dpi', '300', 'tsv']);
    expect(basename(file)).toBe('input.png'); // клиентийн файлын нэр огт ашиглагдахгүй
    expect(call.args.join(' ')).not.toContain('passwd');
    expect(r).toMatchObject({ engine: 'tesseract', engineVersion: '5.3.4', languages: ['mon', 'eng'], text: 'Овог Дорж', durationMs: 250 });
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].width).toBe(800);
    expect(r.meanConfidence).toBeCloseTo(0.9, 10);
  });

  it('тохируулсан psm/dpi/хэл/bin-ийг ашиглана; input.languages нь provider-ийнхийг дарна', async () => {
    const { provider, work } = harness(() => ok(tsv(word('а'))), { psm: 4, dpi: 400, languages: ['eng'], tesseractBin: '/opt/tess/bin/tesseract' });
    await provider.recognize(png());
    await provider.recognize(png({ languages: ['mon', 'rus'] }));
    const [a, b] = work();
    expect(a.cmd).toBe('/opt/tess/bin/tesseract');
    expect(a.args.slice(1)).toEqual(['stdout', '-l', 'eng', '--psm', '4', '--dpi', '400', 'tsv']);
    expect(b.args[3]).toBe('mon+rus');
  });

  it('хувийн (0700) түр хавтас + 0600 файл ашиглаад амжилттай дууссаны дараа УСТГАНА; --version нэг л удаа (кэш)', async () => {
    let dir = '';
    let dirMode = 0;
    let fileMode = 0;
    const { provider, calls } = harness((c) => {
      dir = dirname(c.args[0]);
      dirMode = statSync(dir).mode & 0o777;
      fileMode = statSync(c.args[0]).mode & 0o777;
      return ok(tsv(word('а')));
    });
    await provider.recognize(png());
    await provider.recognize(png());
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(calls.filter((c) => c.args[0] === '--version')).toHaveLength(1);
  });

  it('аль ч алдаанд түр хавтас устна (ENOENT, non-zero, timeout, EMPTY_RESULT)', async () => {
    const dirs: string[] = [];
    const cases: Array<[string, Handler]> = [
      ['ENGINE_UNAVAILABLE', () => { throw spawnError('ENOENT'); }],
      ['ENGINE_FAILED', () => ok('', { exitCode: 2, stderr: 'boom' })],
      ['TIMEOUT', () => ok('', { exitCode: null, timedOut: true })],
      ['EMPTY_RESULT', () => ok(tsv())],
    ];
    for (const [code, h] of cases) {
      const { provider } = harness((c) => {
        dirs.push(dirname(c.args[0]));
        return h(c);
      });
      expect((await fail(provider.recognize(png()))).code).toBe(code);
    }
    expect(dirs).toHaveLength(4);
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });

  it('агуулгын өргөтгөл нь magic bytes-аар: image/png гэсэн ч JPEG байвал input.jpg', async () => {
    const { provider, work } = harness(() => ok(tsv(word('а'))));
    await provider.recognize({ content: JPEG, mimeType: 'image/png' });
    expect(basename(work()[0].args[0])).toBe('input.jpg');
  });

  it('урт хугацааны мэдээлэл: runner-т үлдсэн хугацааг (deadline - now) өгнө', async () => {
    const { provider, work } = harness(() => ok(tsv(word('а'))), { timeoutMs: 5_000 });
    await provider.recognize(png());
    await provider.recognize(png({ timeoutMs: 1_234 }));
    expect(work().map((c) => c.opts.timeoutMs)).toEqual([5_000, 1_234]);
  });

  it('runner-т stdout/stderr хязгаар, цагаан жагсаалтын env өгнө (нууц утга дамжихгүй)', async () => {
    const { provider, work } = harness(() => ok(tsv(word('а'))), {
      maxStdoutBytes: 4096,
      env: { PATH: '/usr/bin', TESSDATA_PREFIX: '/tessdata', DATABASE_URL: 'postgres://secret', JWT_SECRET: 'x' },
    });
    await provider.recognize(png());
    const { opts } = work()[0];
    expect(opts.maxStdoutBytes).toBe(4096);
    expect(opts.maxStderrBytes).toBeGreaterThan(0);
    expect(opts.env).toMatchObject({ PATH: '/usr/bin', TESSDATA_PREFIX: '/tessdata', OMP_THREAD_LIMIT: '1' });
    expect(opts.env).not.toHaveProperty('DATABASE_URL');
    expect(opts.env).not.toHaveProperty('JWT_SECRET');
  });

  it('олон хуудастай TIFF: хуудасны хязгаараас илүүг орхиж анхааруулга өгнө', async () => {
    const multi = [HEADER, ...[1, 2, 3].map((n) => ['5', String(n), '1', '1', '1', '1', '0', '0', '5', '5', '90', `х${n}`].join('\t'))].join('\n');
    const { provider } = harness(() => ok(multi), { maxPages: 2 });
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
    const r = await provider.recognize({ content: tiff, mimeType: 'image/tiff' });
    expect(r.pages.map((p) => p.text)).toEqual(['х1', 'х2']);
    expect(r.warnings?.[0]).toMatch(/2 хуудс/);
  });
});

describe('TesseractOcrProvider: оролтын шалгалт', () => {
  it('хоосон, хэт том, дэмжигдээгүй MIME, буруу агуулга → runner дуудахгүйгээр алдаа', async () => {
    const { provider, calls } = harness(() => ok(tsv(word('а'))), { maxInputBytes: 64 });
    expect((await fail(provider.recognize({ content: Buffer.alloc(0), mimeType: 'image/png' }))).code).toBe('INVALID_INPUT');
    expect((await fail(provider.recognize({ content: Buffer.concat([PNG, Buffer.alloc(100)]), mimeType: 'image/png' }))).code).toBe('INVALID_INPUT');
    expect((await fail(provider.recognize({ content: PNG, mimeType: 'text/plain' }))).code).toBe('UNSUPPORTED_MIME');
    expect((await fail(provider.recognize({ content: PNG, mimeType: 'image/gif' }))).code).toBe('UNSUPPORTED_MIME');
    expect((await fail(provider.recognize({ content: null as unknown as Buffer, mimeType: 'image/png' }))).code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('PNG гэж зарласан боловч агуулга нь текст (Tesseract-ийн "зургийн жагсаалт" онцлогоор файл уншуулах эрсдэл) → INVALID_INPUT, runner дуудагдахгүй', async () => {
    const { provider, calls } = harness(() => ok(tsv(word('а'))));
    const e = await fail(provider.recognize({ content: Buffer.from('/etc/passwd\n/home/user/secret.png\n'), mimeType: 'image/png' }));
    expect(e.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('хэлний код: injection оролдлого, том үсэг, хоосон, хэт олон → INVALID_INPUT; runner дуудагдахгүй', async () => {
    const { provider, calls } = harness(() => ok(tsv(word('а'))));
    for (const languages of [['mon', '--oem'], ['-l'], ['mon+eng'], ['MON'], ['mo'], [''], ['mon eng'], ['mon', 'eng', 'rus', 'chi_sim', 'jpn', 'kor', 'ara'], []]) {
      expect((await fail(provider.recognize(png({ languages })))).code).toBe('INVALID_INPUT');
    }
    expect(calls).toHaveLength(0);
    // зөв кодууд (жишээ chi_sim) давхардалгүйгээр дамжина
    await provider.recognize(png({ languages: ['chi_sim', 'eng', 'eng'] }));
    expect(calls[0].args[3]).toBe('chi_sim+eng');
  });

  it('timeoutMs буруу → INVALID_INPUT', async () => {
    const { provider } = harness(() => ok(tsv(word('а'))));
    for (const timeoutMs of [0, -1, 1.5, 10 * 60_000 + 1, Number.NaN]) expect((await fail(provider.recognize(png({ timeoutMs })))).code).toBe('INVALID_INPUT');
  });

  it('constructor-ын буруу тохиргоо Error шиддэг', () => {
    const bad: TesseractOcrProviderOptions[] = [{ psm: 14 }, { psm: 1.5 }, { dpi: 10 }, { maxPages: 0 }, { timeoutMs: 0 }, { languages: ['x'] }];
    for (const o of bad) expect(() => new TesseractOcrProvider(o)).toThrow();
  });
});

describe('TesseractOcrProvider: алдааны хөрвүүлэлт', () => {
  it('ENOENT → ENGINE_UNAVAILABLE + суулгах заавар; EACCES → ENGINE_UNAVAILABLE; бусад spawn алдаа → ENGINE_FAILED', async () => {
    const mk = (code: string) => harness(() => { throw spawnError(code); }, { tesseractBin: 'my-tesseract' }).provider;
    const e = await fail(mk('ENOENT').recognize(png()));
    expect(e.code).toBe('ENGINE_UNAVAILABLE');
    expect(e.message).toContain('my-tesseract');
    expect(e.message).toMatch(/apt-get install tesseract-ocr/);
    expect((await fail(mk('EACCES').recognize(png()))).code).toBe('ENGINE_UNAVAILABLE');
    expect((await fail(mk('EMFILE').recognize(png()))).code).toBe('ENGINE_FAILED');
  });

  it('non-zero exit → ENGINE_FAILED; stderr-ээс баримтын текст/урт цифр мессежид ОРОХГҮЙ', async () => {
    const { provider } = harness(() => ok('', { exitCode: 1, stderr: 'Дорж Болд УБ90010203 5011234567 Image file Дансны-эзэмшигч cannot-be-x ' + 'я'.repeat(500) }));
    const e = await fail(provider.recognize(png()));
    expect(e.code).toBe('ENGINE_FAILED');
    expect(e.message).toContain('код 1');
    expect(e.message).not.toMatch(/Дорж|Болд|УБ9|5011234567|эзэмшигч/);
    expect(e.message.length).toBeLessThan(260);
    expect(e.cause).toBeUndefined();
  });

  it('stderr-ийн ангилал: хэлний өгөгдөл дутуу → ENGINE_UNAVAILABLE; зураг уншигдахгүй → INVALID_INPUT', async () => {
    const lang = harness(() => ok('', { exitCode: 1, stderr: "Failed loading language 'mon'\nTesseract couldn't load any languages!" })).provider;
    expect((await fail(lang.recognize(png()))).code).toBe('ENGINE_UNAVAILABLE');
    const bad = harness(() => ok('', { exitCode: 1, stderr: 'Error in pixReadStreamPng: internal png error\nError in pixRead: pix not read' })).provider;
    expect((await fail(bad.recognize(png()))).code).toBe('INVALID_INPUT');
  });

  it('timeout → TIMEOUT; stdout хязгаар хэтэрсэн → ENGINE_FAILED; EMPTY_RESULT', async () => {
    expect((await fail(harness(() => ok('', { exitCode: null, timedOut: true })).provider.recognize(png()))).code).toBe('TIMEOUT');
    const big = await fail(harness(() => ok('', { stdoutTruncated: true })).provider.recognize(png()));
    expect(big.code).toBe('ENGINE_FAILED');
    expect(big.message).toMatch(/том/);
    expect((await fail(harness(() => ok(tsv(word('  ', 90)))).provider.recognize(png()))).code).toBe('EMPTY_RESULT');
  });

  it('хугацаа аль хэдийн дууссан бол процесс эхлүүлэхгүй TIMEOUT (PDF-ийн хуудас хооронд)', async () => {
    const { provider, clock, work } = harness(
      (c) => {
        if (c.cmd === 'pdftoppm') {
          const prefix = c.args[c.args.length - 1];
          for (const n of [1, 2, 3]) writeFileSync(`${prefix}-${n}.png`, 'x');
          return ok();
        }
        clock.now += 600; // нэг хуудас 600мс
        return ok(tsv(word('а')));
      },
      { timeoutMs: 1_000 },
    );
    const e = await fail(provider.recognize({ content: PDF, mimeType: 'application/pdf' }));
    expect(e.code).toBe('TIMEOUT');
    // 3 хуудас × 600мс, хязгаар 1000мс: 1, 2-р хуудас ажиллаж, 3-р хуудасны өмнө deadline дууссан тул процесс эхлээгүй
    expect(work().filter((c) => c.cmd === 'tesseract')).toHaveLength(2);
    expect(work().filter((c) => c.cmd === 'tesseract').map((c) => c.opts.timeoutMs)).toEqual([1_000, 400]);
  });
});

describe('TesseractOcrProvider: PDF', () => {
  const pdfHandler = (pagesToRender: number, ocrText = (n: number) => `хуудас${n}`): Handler => (c) => {
    if (c.cmd === 'pdftoppm') {
      const prefix = c.args[c.args.length - 1];
      const width = String(pagesToRender).length;
      for (let n = 1; n <= pagesToRender; n++) writeFileSync(`${prefix}-${String(n).padStart(width, '0')}.png`, 'x');
      return ok();
    }
    const m = /page-(\d+)\.png$/.exec(c.args[0]);
    return ok(tsv(word(ocrText(Number(m?.[1])))));
  };

  it('pdftoppm -r 300 -png → хуудас бүрт tesseract; pageNo нь файлын дугаараас; түр хавтас устна', async () => {
    const { provider, work } = harness(pdfHandler(3));
    const r = await provider.recognize({ content: PDF, mimeType: 'application/pdf', fileName: 'x.pdf' });
    const [render, ...pages] = work();
    expect(render.cmd).toBe('pdftoppm');
    expect(render.args.slice(0, 7)).toEqual(['-r', '300', '-png', '-f', '1', '-l', '21']); // maxPages(20)+1
    expect(basename(render.args[7])).toBe('input.pdf');
    expect(pages.map((c) => basename(c.args[0]))).toEqual(['page-1.png', 'page-2.png', 'page-3.png']);
    expect(r.pages.map((p) => [p.pageNo, p.text])).toEqual([[1, 'хуудас1'], [2, 'хуудас2'], [3, 'хуудас3']]);
    expect(r.text).toBe('хуудас1\n\fхуудас2\n\fхуудас3');
    expect(r.warnings).toBeUndefined();
    expect(existsSync(dirname(render.args[7]))).toBe(false);
  });

  it('хуудасны хязгаар: maxPages+1 хуудас рендерлэж, илүүг орхиж, анхааруулга өгнө', async () => {
    const { provider, work } = harness(pdfHandler(3), { maxPages: 2 });
    const r = await provider.recognize({ content: PDF, mimeType: 'application/pdf' });
    expect(work()[0].args.slice(5, 7)).toEqual(['-l', '3']);
    expect(r.pages.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(work().filter((c) => c.cmd === 'tesseract')).toHaveLength(2);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings?.[0]).toMatch(/2/);
  });

  it('10+ хуудас: pdftoppm-ийн тэгээр дүүргэсэн нэр (page-01.png) зөв эрэмбэлэгдэнэ', async () => {
    const { provider } = harness(pdfHandler(12));
    const r = await provider.recognize({ content: PDF, mimeType: 'application/pdf' });
    expect(r.pages.map((p) => p.pageNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('хуудас бүр үггүй бол EMPTY_RESULT; зарим хуудас хоосон бол хуудас үлдэнэ', async () => {
    const empty = harness((c) => (c.cmd === 'pdftoppm' ? pdfHandler(2)(c) : ok(tsv()))).provider;
    expect((await fail(empty.recognize({ content: PDF, mimeType: 'application/pdf' }))).code).toBe('EMPTY_RESULT');
    const partial = harness((c) => {
      if (c.cmd === 'pdftoppm') return pdfHandler(2)(c);
      return /page-2/.test(c.args[0]) ? ok(tsv()) : ok(tsv(word('нэг')));
    }).provider;
    const r = await partial.recognize({ content: PDF, mimeType: 'application/pdf' });
    expect(r.pages.map((p) => [p.pageNo, p.lines.length])).toEqual([[1, 1], [2, 0]]);
  });

  it('pdftoppm алдаа: exit 1/3 → INVALID_INPUT (эвдэрсэн/нууц үгтэй); бусад → ENGINE_FAILED; ENOENT → ENGINE_UNAVAILABLE; 0 хуудас → INVALID_INPUT', async () => {
    const withExit = (code: number) => harness(() => ok('', { exitCode: code, stderr: 'Syntax Error: Дорж' })).provider;
    expect((await fail(withExit(1).recognize({ content: PDF, mimeType: 'application/pdf' }))).code).toBe('INVALID_INPUT');
    expect((await fail(withExit(3).recognize({ content: PDF, mimeType: 'application/pdf' }))).code).toBe('INVALID_INPUT');
    const e = await fail(withExit(99).recognize({ content: PDF, mimeType: 'application/pdf' }));
    expect(e.code).toBe('ENGINE_FAILED');
    expect(e.message).not.toContain('Дорж');
    const missing = harness(() => { throw spawnError('ENOENT'); }, { pdftoppmBin: 'my-pdftoppm' }).provider;
    const m = await fail(missing.recognize({ content: PDF, mimeType: 'application/pdf' }));
    expect([m.code, m.message.includes('my-pdftoppm')]).toEqual(['ENGINE_UNAVAILABLE', true]);
    const none = harness(() => ok()).provider;
    expect((await fail(none.recognize({ content: PDF, mimeType: 'application/pdf' }))).code).toBe('INVALID_INPUT');
  });

  it('PDF-ийн түр хавтас pdftoppm-ийн гаралттай хамт бүрэн устна', async () => {
    let dir = '';
    const { provider } = harness((c) => {
      dir = dirname(c.args[c.cmd === 'pdftoppm' ? 7 : 0]);
      return pdfHandler(2)(c);
    });
    await provider.recognize({ content: PDF, mimeType: 'application/pdf' });
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(tmpdir()).map((n) => join(tmpdir(), n))).not.toContain(dir);
  });
});

describe('TesseractOcrProvider: engineVersion, healthCheck', () => {
  it('--version амжилтгүй бол engineVersion null (OCR-ийг унагахгүй), дараагийн дуудлагад дахин оролдоно', async () => {
    const calls: string[] = [];
    let versionOk = false;
    const runner: CommandRunner = async (_cmd, args) => {
      if (args[0] === '--version') {
        calls.push('v');
        if (!versionOk) throw spawnError('ENOENT');
        return VERSION_OUT;
      }
      return ok(tsv(word('а')));
    };
    const provider = new TesseractOcrProvider({ runner });
    expect((await provider.recognize(png())).engineVersion).toBeNull();
    versionOk = true;
    expect((await provider.recognize(png())).engineVersion).toBe('5.3.4');
    expect(calls).toEqual(['v', 'v']);
  });

  const langsOut = (...langs: string[]) => ok(`List of available languages in "/usr/share/tessdata/" (${langs.length}):\n${langs.join('\n')}\n`);

  it('бүх хэл байвал ok (хувилбар, pdftoppm тэмдэглэгээтэй)', async () => {
    const { provider } = harness((c) => (c.args[0] === '--list-langs' ? langsOut('eng', 'mon', 'osd') : ok('', { stderr: 'pdftoppm version 24' })));
    const h = await provider.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('5.3.4');
    expect(h.detail).toContain('mon+eng');
  });

  it('хэл дутвал ok=false ба дутуу хэлийг нэрлэнэ; хуучин tesseract (stderr-д жагсаалт) ч ажиллана', async () => {
    const missing = harness(() => langsOut('eng')).provider;
    const h = await missing.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('mon');
    const legacy = harness((c) => (c.args[0] === '--list-langs' ? ok('', { stderr: 'List of available languages (2):\nmon\neng\n' }) : ok())).provider;
    expect((await legacy.healthCheck()).ok).toBe(true);
  });

  it('tesseract олдохгүй → ok=false + суулгах заавар; --list-langs алдаатай/timeout → ok=false', async () => {
    const none = harness(() => { throw spawnError('ENOENT'); }).provider;
    const h = await none.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/apt-get install/);
    expect((await harness(() => ok('', { exitCode: 1 })).provider.healthCheck()).ok).toBe(false);
    expect((await harness(() => ok('', { exitCode: null, timedOut: true })).provider.healthCheck()).ok).toBe(false);
  });

  it('pdftoppm байхгүй бол ok хэвээр (зөвхөн зураг), detail-д тэмдэглэнэ', async () => {
    const { provider } = harness((c) => {
      if (c.cmd === 'pdftoppm') throw spawnError('ENOENT');
      return langsOut('eng', 'mon');
    });
    const h = await provider.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatch(/pdftoppm: олдсонгүй/);
  });
});

describe('scrubDiagnostic', () => {
  it('temp замыг <tmp> болгож, ASCII бус тэмдэгтийг ?, 4+ цифрийг #### болгож, 160 тэмдэгтээр таслана', () => {
    const out = scrubDiagnostic('Error at /tmp/los-ocr-abc/input.png: Дорж 12345678 ok', '/tmp/los-ocr-abc');
    expect(out).toBe('Error at <tmp>/input.png: ???? #### ok');
    const long = scrubDiagnostic('x'.repeat(500));
    expect(long.length).toBe(163);
    expect(long.endsWith('...')).toBe(true);
    expect(scrubDiagnostic('')).toBe('');
  });
});
