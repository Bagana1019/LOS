import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z, type ZodError, type ZodIssue, type ZodTypeAny } from 'zod';

type PathKey = string | number;
interface Node { value: unknown; key: PathKey | null; parent: Node | null }

// FR-13.1: DB-д хадгалагдахгүй (NUL, lone surrogate) эсвэл өгөгдлийг чимээгүй гажуудуулдаг (U+FFFD) текст.
const NUL_MESSAGE = 'NUL (U+0000) characters are not allowed';
// U+FFFD нь буруу кодчилсон (UTF-8 биш) байтыг декодер сольсон тэмдэг: регистр/нэрээс үсэг чимээгүй алдагдаж, kyc-д хэзээ ч таарахгүй.
const REPLACEMENT_MESSAGE = 'U+FFFD replacement characters are not allowed (the text was not valid UTF-8)';
const SURROGATE_MESSAGE = 'invalid Unicode (lone surrogate) is not allowed';
/** Түлхүүрт буруу тэмдэгт байвал түлхүүрийг (хүсэлтийн өгөгдөл) эхo хийхгүй, зөвхөн эцэг объектын замыг өгнө. */
const KEY_SUFFIX = ' (in an object key)';

// `u` тугтай regex-д хос биш (lone) surrogate нь \p{Surrogate}-д таарна, хос нь нэг astral тэмдэгт тул таарахгүй:
// String.prototype.isWellFormed()-тэй тэнцүү (ES2024 typings шаардахгүй; parity тестээр баталгаажна).
const LONE_SURROGATE = /\p{Surrogate}/u;

/** Хориотой тэмдэгт агуулсан бол алдааны мессеж (утгыг агуулахгүй), үгүй бол null. */
export function unsafeTextMessage(text: string): string | null {
  if (text.includes('\u0000')) return NUL_MESSAGE;
  if (text.includes('\uFFFD')) return REPLACEMENT_MESSAGE;
  if (LONE_SURROGATE.test(text)) return SURROGATE_MESSAGE;
  return null;
}

/**
 * Хориотой тэмдэгт (U+0000, U+FFFD, lone surrogate) агуулсан эхний string (утга эсвэл түлхүүр)-ийн зам ба мессеж.
 * Postgres NUL (22021) болон lone surrogate (Prisma JSON протокол)-ыг хүлээн авдаггүй тул DB хүртэл оруулахгүй.
 * Давталттай (рекурс биш) — гүн үүрлэсэн JSON-оор стек дүүргэж болохгүй.
 */
export function findUnsafeText(root: unknown): { path: PathKey[]; message: string } | null {
  const stack: Node[] = [{ value: root, key: null, parent: null }];
  const pathOf = (node: Node): PathKey[] => {
    const path: PathKey[] = [];
    for (let n: Node | null = node; n; n = n.parent) if (n.key !== null) path.push(n.key);
    return path.reverse();
  };
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    const v = node.value;
    if (typeof v === 'string') {
      const message = unsafeTextMessage(v);
      if (message) return { path: pathOf(node), message };
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => stack.push({ value: item, key: i, parent: node }));
    } else if (v !== null && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        const message = unsafeTextMessage(k);
        if (message) return { path: pathOf(node), message: `${message}${KEY_SUFFIX}` };
        stack.push({ value: item, key: k, parent: node });
      }
    }
  }
  return null;
}

/** Бие / query / path / CSV текстэд хориотой тэмдэгт байвал 400 (утгыг алдаанд echo хийхгүй). */
export function assertCleanText(value: unknown, hint = ''): void {
  const found = findUnsafeText(value);
  if (found) throw new BadRequestException({ statusCode: 400, message: 'Validation failed', issues: [{ code: 'custom', path: found.path, message: `${found.message}${hint}` }] });
}

/** Хүсэлтийн өгөгдлийг (register, нэр, түлхүүр) агуулдаг zod-ын "received ..." мессежийг хориглож, код тус бүрт тогтмол мессеж өгнө. */
export interface SafeIssue { code: string; path: PathKey[]; message: string; expected?: string; options?: string[] }

const quoted = (options: readonly unknown[]) => options.map((o) => `'${String(o)}'`).join(' | ');

function safeMessage(issue: ZodIssue): string {
  switch (issue.code) {
    // Схемээс гарсан (өгөгдөл агуулдаггүй) мессеж: custom (бидний refine), хэмжээ, формат.
    case 'custom':
    case 'too_small':
    case 'too_big':
    case 'invalid_string':
    case 'invalid_date':
    case 'not_multiple_of':
    case 'not_finite':
      return issue.message;
    case 'invalid_type':
      return issue.received === 'undefined' ? 'Required' : `Expected ${issue.expected}`;
    case 'invalid_enum_value':
      return `Invalid enum value. Expected ${quoted(issue.options)}`;
    case 'invalid_literal':
      return `Invalid literal value. Expected ${JSON.stringify(issue.expected)}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object (${issue.keys.length})`;
    default:
      return 'Invalid input';
  }
}

/** zod-ын алдааг клиентэд буцаах аюулгүй хэлбэрт оруулна (`received`, `keys`, утга байхгүй). */
export function safeIssues(error: ZodError): SafeIssue[] {
  return error.issues.map((issue): SafeIssue => ({
    code: issue.code,
    path: issue.path,
    message: safeMessage(issue),
    ...(issue.code === 'invalid_type' && { expected: issue.expected }),
    ...(issue.code === 'invalid_enum_value' && { options: issue.options.map(String) }),
  }));
}

/** DTO-г @los/contracts-ийн zod схемээр шалгана; алдаа 400 + issues (stack, хүлээн авсан утгагүй). Бие / query / path параметрт хориотой тэмдэгт (NUL, U+FFFD, lone surrogate) байвал 400. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    assertCleanText(value);
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException({ statusCode: 400, message: 'Validation failed', issues: safeIssues(parsed.error) });
    return parsed.data;
  }
}

/** Path параметр (:id): хоосон биш, хориотой тэмдэгтгүй string. Тодорхойгүй id нь service дээр 404 болно. */
export const PathParam = new ZodPipe(z.string().min(1));
