// TesseractOcrProvider — Tesseract 5 CLI-г injectable runner-ээр дуудна (CLAUDE.md §3.2(7) RealXxx). SHELL-ГҮЙ, args массив.
//  Зураг: tesseract <in> stdout -l mon+eng --psm <6> --dpi 300 tsv
//  PDF:   pdftoppm -r 300 -png (хувийн mkdtemp 0700 хавтас) → хуудас бүрт tesseract
// Аюулгүй байдал: (1) агуулгыг magic bytes-аар шалгана — Tesseract танигдаагүй файлыг "зургийн замуудын жагсаалт" гэж унших
// онцлогтой (локал файл уншуулах эрсдэл) тул зөвхөн PNG/JPEG/TIFF/WebP/PDF-ийг дамжуулна; (2) файлын нэрийг клиентээс авахгүй (input.<ext>);
// (3) хэлний код хатуу regex; (4) алдааны мессежид stderr-ийг зөвхөн scrub хийж (ASCII, цифр далдалсан, ≤ 160) оруулна, текст хэзээ ч биш.
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OCR_DEFAULTS } from '../defaults';
import { detectOcrMime, normalizeOcrMime, OCR_MIME_EXTENSIONS, type OcrSupportedMime } from '../mime';
import { OcrError, type OcrInput, type OcrPage, type OcrProvider, type OcrResult } from '../types';
import { validateLanguages } from './languages';
import { assembleOcrResult } from './result';
import { buildChildEnv, spawnRunner, type CommandRunner, type RunResult } from './runner';
import { parseTesseractTsv } from './tesseract.tsv';

export interface TesseractOcrProviderOptions {
  tesseractBin?: string;
  pdftoppmBin?: string;
  languages?: readonly string[];
  psm?: number;
  dpi?: number;
  timeoutMs?: number;
  maxPages?: number;
  maxInputBytes?: number;
  maxStdoutBytes?: number;
  /** Тест: дэд процесс ажиллуулагч (анхдагч: spawn, shell-гүй) */
  runner?: CommandRunner;
  /** Тест: цаг (ms). Анхдагч Date.now */
  clock?: () => number;
  /** Тест: түр хавтасны эх (анхдагч os.tmpdir()) */
  tmpRoot?: string;
  /** Дэд процессын env-ийн эх (анхдагч process.env; цагаан жагсаалтаар шүүгдэнэ) */
  env?: NodeJS.ProcessEnv;
}

const INSTALL_HINT = 'Суулгах: apt-get install tesseract-ocr tesseract-ocr-mon tesseract-ocr-eng poppler-utils (эсвэл TESSERACT_BIN / PDFTOPPM_BIN env)';
const VERSION_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** Tesseract stderr-ийн ЗАЛХУУ оношилгооны мөрүүд (тэдний дотор баримтын текст байхгүй гэдэгт итгэж болох ангилал) */
const IMAGE_UNREADABLE_RE = /pixRead|pix not read|libpng error|cannot be read|Pix read failed|Unknown format|unsupported/i;
const LANGUAGE_MISSING_RE = /Failed loading language|Error opening data file|couldn't load any languages/i;

function assertInt(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} нь ${min}..${max} хоорондын бүхэл тоо байх ёстой`);
  return value;
}

/** stderr-ийг мессежид оруулахын өмнө цэвэрлэнэ: temp зам, ASCII бус тэмдэгт, 4+ цифр далдлах, ≤ 160 тэмдэгт. */
export function scrubDiagnostic(stderr: string, tempDir?: string): string {
  let s = stderr;
  if (tempDir) s = s.split(tempDir).join('<tmp>');
  s = s.replace(/[^\x20-\x7e\n]/g, '?').replace(/\d{4,}/g, '####').replace(/\s+/g, ' ').trim();
  return s.length > 160 ? `${s.slice(0, 160)}...` : s;
}

export class TesseractOcrProvider implements OcrProvider {
  readonly name = 'tesseract';
  private readonly tesseractBin: string;
  private readonly pdftoppmBin: string;
  private readonly languages: string[];
  private readonly psm: number;
  private readonly dpi: number;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly maxInputBytes: number;
  private readonly maxStdoutBytes: number;
  private readonly runner: CommandRunner;
  private readonly clock: () => number;
  private readonly tmpRoot: string;
  private readonly childEnv: NodeJS.ProcessEnv;
  private versionPromise: Promise<string | null> | null = null;

  constructor(options: TesseractOcrProviderOptions = {}) {
    this.tesseractBin = options.tesseractBin ?? OCR_DEFAULTS.tesseractBin;
    this.pdftoppmBin = options.pdftoppmBin ?? OCR_DEFAULTS.pdftoppmBin;
    this.languages = validateLanguages(options.languages ?? OCR_DEFAULTS.languages);
    this.psm = assertInt('psm', options.psm ?? OCR_DEFAULTS.psm, 0, 13);
    this.dpi = assertInt('dpi', options.dpi ?? OCR_DEFAULTS.dpi, 70, 2400);
    this.timeoutMs = assertInt('timeoutMs', options.timeoutMs ?? OCR_DEFAULTS.timeoutMs, 1, MAX_TIMEOUT_MS);
    this.maxPages = assertInt('maxPages', options.maxPages ?? OCR_DEFAULTS.maxPages, 1, 500);
    this.maxInputBytes = assertInt('maxInputBytes', options.maxInputBytes ?? OCR_DEFAULTS.maxInputBytes, 1, 1024 * 1024 * 1024);
    this.maxStdoutBytes = assertInt('maxStdoutBytes', options.maxStdoutBytes ?? OCR_DEFAULTS.maxStdoutBytes, 1024, 1024 * 1024 * 1024);
    this.runner = options.runner ?? spawnRunner;
    this.clock = options.clock ?? Date.now;
    this.tmpRoot = options.tmpRoot ?? tmpdir();
    this.childEnv = buildChildEnv(options.env ?? process.env);
  }

  async recognize(input: OcrInput): Promise<OcrResult> {
    const started = this.clock();
    const mime = this.validateInput(input);
    const languages = validateLanguages(input.languages ?? this.languages);
    const timeoutMs = this.resolveTimeout(input.timeoutMs);
    const deadline = started + timeoutMs;

    let dir: string;
    try {
      dir = await mkdtemp(join(this.tmpRoot, 'los-ocr-'));
    } catch (cause) {
      throw new OcrError('ENGINE_FAILED', 'OCR-ийн түр хавтас үүсгэж чадсангүй', cause);
    }
    const warnings: string[] = [];
    let pages: OcrPage[];
    try {
      await chmod(dir, 0o700);
      const inputPath = join(dir, `input.${OCR_MIME_EXTENSIONS[mime]}`);
      await writeFile(inputPath, input.content, { mode: 0o600 });
      pages = mime === 'application/pdf' ? await this.recognizePdf(dir, inputPath, languages, deadline, warnings) : await this.recognizeImage(inputPath, languages, deadline, dir, warnings);
    } catch (err) {
      if (err instanceof OcrError) throw err;
      throw new OcrError('ENGINE_FAILED', 'OCR боловсруулалт амжилтгүй (файл систем)', err);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }

    if (!pages.some((p) => p.lines.length > 0)) throw new OcrError('EMPTY_RESULT', 'OCR текст олдсонгүй');
    const engineVersion = await this.getEngineVersion();
    return assembleOcrResult(pages, { engine: this.name, engineVersion, languages, durationMs: Math.max(0, this.clock() - started), warnings });
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    let langs: RunResult;
    try {
      langs = await this.runner(this.tesseractBin, ['--list-langs'], this.runOptions(HEALTH_TIMEOUT_MS));
    } catch (err) {
      return { ok: false, detail: this.spawnFailureMessage(err, this.tesseractBin) };
    }
    if (langs.timedOut || langs.exitCode !== 0) return { ok: false, detail: 'tesseract --list-langs амжилтгүй' };
    // `tesseract --list-langs`: эхний мөр "List of available languages ...", дараа нь хэл бүр нэг мөрөнд (stdout эсвэл хуучин хувилбарт stderr)
    const available = new Set(`${langs.stdout}\n${langs.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z_]+$/.test(l)));
    const missing = this.languages.filter((l) => !available.has(l));
    if (missing.length > 0) return { ok: false, detail: `Дутуу хэл: ${missing.join('+')} (tesseract-ocr-<lang> суулгана уу)` };
    let pdfNote = 'pdftoppm: байна';
    try {
      const pdf = await this.runner(this.pdftoppmBin, ['-v'], this.runOptions(HEALTH_TIMEOUT_MS));
      if (pdf.timedOut) pdfNote = 'pdftoppm: хариу өгсөнгүй (PDF OCR найдваргүй)';
    } catch {
      pdfNote = 'pdftoppm: олдсонгүй (PDF OCR ажиллахгүй, зөвхөн зураг)';
    }
    return { ok: true, detail: `tesseract ${(await this.getEngineVersion()) ?? '?'}; хэл: ${this.languages.join('+')}; ${pdfNote}` };
  }

  // ---- дотоод ----

  /** Оролтыг шалгаж, агуулгаас тодорхойлсон MIME-ийг буцаана. */
  private validateInput(input: OcrInput): OcrSupportedMime {
    if (!input || !Buffer.isBuffer(input.content) || input.content.length === 0) throw new OcrError('INVALID_INPUT', 'OCR оролт хоосон байна');
    if (input.content.length > this.maxInputBytes) throw new OcrError('INVALID_INPUT', 'OCR оролтын файл хэт том байна');
    if (!normalizeOcrMime(input.mimeType)) throw new OcrError('UNSUPPORTED_MIME', 'Дэмжигдээгүй файлын төрөл');
    const sniffed = detectOcrMime(input.content);
    if (!sniffed) throw new OcrError('INVALID_INPUT', 'Файлын агуулга дэмжигдэх зураг/PDF-ийн хэлбэртэй таарахгүй байна');
    return sniffed;
  }

  private resolveTimeout(requested: number | undefined): number {
    if (requested === undefined) return this.timeoutMs;
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_TIMEOUT_MS) throw new OcrError('INVALID_INPUT', 'timeoutMs буруу');
    return requested;
  }

  private runOptions(timeoutMs: number) {
    return { timeoutMs, maxStdoutBytes: this.maxStdoutBytes, maxStderrBytes: OCR_DEFAULTS.maxStderrBytes, env: this.childEnv };
  }

  private spawnFailureMessage(err: unknown, bin: string): string {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT') return `'${bin}' олдсонгүй. ${INSTALL_HINT}`;
    if (code === 'EACCES') return `'${bin}' ажиллуулах эрхгүй`;
    return `'${bin}' эхлүүлж чадсангүй`;
  }

  /** Нэг дэд процесс: үлдсэн хугацаа дотор. timeout → TIMEOUT, ENOENT → ENGINE_UNAVAILABLE, stdout хэтэрвэл ENGINE_FAILED. */
  private async run(bin: string, args: readonly string[], deadline: number): Promise<RunResult> {
    const remaining = Math.ceil(deadline - this.clock());
    if (remaining <= 0) throw new OcrError('TIMEOUT', 'OCR хугацаа хэтэрлээ');
    let res: RunResult;
    try {
      res = await this.runner(bin, args, this.runOptions(remaining));
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      throw new OcrError(code === 'ENOENT' || code === 'EACCES' ? 'ENGINE_UNAVAILABLE' : 'ENGINE_FAILED', this.spawnFailureMessage(err, bin), err);
    }
    if (res.timedOut) throw new OcrError('TIMEOUT', 'OCR хугацаа хэтэрлээ');
    if (res.stdoutTruncated) throw new OcrError('ENGINE_FAILED', 'OCR гаралт хэт том байна');
    return res;
  }

  private tesseractArgs(file: string, languages: readonly string[]): string[] {
    return [file, 'stdout', '-l', languages.join('+'), '--psm', String(this.psm), '--dpi', String(this.dpi), 'tsv'];
  }

  private async runTesseract(file: string, languages: readonly string[], deadline: number, dir: string): Promise<OcrPage[]> {
    const res = await this.run(this.tesseractBin, this.tesseractArgs(file, languages), deadline);
    if (res.exitCode !== 0) {
      if (LANGUAGE_MISSING_RE.test(res.stderr)) throw new OcrError('ENGINE_UNAVAILABLE', 'Tesseract-ийн хэлний өгөгдөл суулгагдаагүй (tesseract-ocr-mon, tesseract-ocr-eng)');
      if (IMAGE_UNREADABLE_RE.test(res.stderr)) throw new OcrError('INVALID_INPUT', 'Зургийг уншиж чадсангүй (эвдэрсэн эсвэл дэмжигдээгүй)');
      throw new OcrError('ENGINE_FAILED', `tesseract алдаатай дууслаа (код ${res.exitCode}): ${scrubDiagnostic(res.stderr, dir)}`);
    }
    return parseTesseractTsv(res.stdout);
  }

  private async recognizeImage(file: string, languages: readonly string[], deadline: number, dir: string, warnings: string[]): Promise<OcrPage[]> {
    const parsed = await this.runTesseract(file, languages, deadline, dir);
    if (parsed.length > this.maxPages) warnings.push(`Олон хуудастай зураг: эхний ${this.maxPages} хуудсыг л уншсан`);
    return parsed.slice(0, this.maxPages).map((p, i) => ({ ...p, pageNo: i + 1 }));
  }

  private async recognizePdf(dir: string, file: string, languages: readonly string[], deadline: number, warnings: string[]): Promise<OcrPage[]> {
    // maxPages+1 хуудас хүртэл рендерлэнэ: илүү хуудас гарвал хязгаараас хэтэрснийг мэднэ
    const prefix = join(dir, 'page');
    const args = ['-r', String(this.dpi), '-png', '-f', '1', '-l', String(this.maxPages + 1), file, prefix];
    const render = await this.run(this.pdftoppmBin, args, deadline);
    if (render.exitCode !== 0) {
      // poppler: 1 = PDF нээж чадсангүй, 3 = эрхийн хязгаарлалт (нууц үг/DRM) — оролтын алдаа; бусад нь хөдөлгүүрийн алдаа
      if (render.exitCode === 1 || render.exitCode === 3) throw new OcrError('INVALID_INPUT', 'PDF-ийг нээж чадсангүй (эвдэрсэн эсвэл нууц үгтэй)');
      throw new OcrError('ENGINE_FAILED', `pdftoppm алдаатай дууслаа (код ${render.exitCode}): ${scrubDiagnostic(render.stderr, dir)}`);
    }
    const rendered = (await readdir(dir))
      .map((name) => ({ name, m: /^page-(\d+)\.png$/.exec(name) }))
      .flatMap(({ name, m }) => (m ? [{ name, pageNo: Number(m[1]) }] : []))
      .sort((a, b) => a.pageNo - b.pageNo);
    if (rendered.length === 0) throw new OcrError('INVALID_INPUT', 'PDF-д хуудас олдсонгүй');
    if (rendered.length > this.maxPages) warnings.push(`PDF ${this.maxPages}-аас олон хуудастай: эхний ${this.maxPages} хуудсыг л уншсан`);

    const pages: OcrPage[] = [];
    for (const r of rendered.slice(0, this.maxPages)) {
      const parsed = await this.runTesseract(join(dir, r.name), languages, deadline, dir);
      const page = parsed[0] ?? { pageNo: r.pageNo, width: 0, height: 0, text: '', lines: [], meanConfidence: 0 };
      pages.push({ ...page, pageNo: r.pageNo });
    }
    return pages;
  }

  /** `tesseract --version` (кэшлэгдсэн). Алдаа гарвал null (кэшлэхгүй). */
  private getEngineVersion(): Promise<string | null> {
    if (!this.versionPromise) {
      this.versionPromise = this.runner(this.tesseractBin, ['--version'], this.runOptions(VERSION_TIMEOUT_MS)).then(
        (res) => {
          const m = /tesseract\s+v?(\d[\w.-]*)/i.exec(`${res.stdout}\n${res.stderr}`);
          if (!m) this.versionPromise = null;
          return m ? m[1] : null;
        },
        () => {
          this.versionPromise = null;
          return null;
        },
      );
    }
    return this.versionPromise;
  }
}
