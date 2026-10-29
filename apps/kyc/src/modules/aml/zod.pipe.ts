import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z, type ZodTypeAny } from 'zod';

type PathKey = string | number;
interface Node { value: unknown; key: PathKey | null; parent: Node | null }

/** DB хүртэл оруулж болохгүй тэмдэгт мөрийн төрөл: NUL (Postgres 22021) ба буруу бүтэцтэй Unicode (дан surrogate — Prisma-ийн JSON протокол унадаг). */
export type UnsafeStringKind = 'NUL' | 'UNICODE';
export interface UnsafeStringAt { path: PathKey[]; kind: UnsafeStringKind }

const MESSAGES: Record<UnsafeStringKind, string> = {
  NUL: 'NUL (U+0000) characters are not allowed',
  UNICODE: 'Invalid Unicode (lone surrogate) is not allowed',
};

// Node 22: String.prototype.isWellFormed (ES2024); tsconfig target ES2022-ийн lib-д төрөл нь байхгүй.
const isWellFormed = (s: string): boolean => (s as string & { isWellFormed(): boolean }).isWellFormed();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Түлхүүрийг хариунд харуулахад аюулгүй болгоно: NUL ба дан surrogate-ийг \uXXXX хэлбэрээр. */
function escapeKey(key: string): string {
  return key.split('\u0000').join('\\u0000').replace(LONE_SURROGATE, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/**
 * U+0000 эсвэл буруу бүтэцтэй Unicode (дан surrogate) агуулсан эхний string (түлхүүр эсвэл утга)-ийн зам. Postgres NUL-ийг хүлээн авдаггүй
 * (22021), Prisma-ийн JSON протокол дан surrogate дээр унадаг тул DB хүртэл оруулахгүй (500 биш 400).
 * Давталттай (рекурс биш) — гүн үүрлэсэн JSON-оор стек дүүргэж болохгүй.
 */
export function findUnsafeString(root: unknown): UnsafeStringAt | null {
  const stack: Node[] = [{ value: root, key: null, parent: null }];
  const pathOf = (node: Node): PathKey[] => {
    const path: PathKey[] = [];
    for (let n: Node | null = node; n; n = n.parent) if (n.key !== null) path.push(n.key);
    return path.reverse();
  };
  const kindOf = (s: string): UnsafeStringKind | null => (s.includes('\u0000') ? 'NUL' : isWellFormed(s) ? null : 'UNICODE');
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    const v = node.value;
    if (typeof v === 'string') {
      const kind = kindOf(v);
      if (kind) return { path: pathOf(node), kind };
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => stack.push({ value: item, key: i, parent: node }));
    } else if (v !== null && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        const kind = kindOf(k);
        if (kind) return { path: [...pathOf(node), escapeKey(k)], kind };
        stack.push({ value: item, key: k, parent: node });
      }
    }
  }
  return null;
}

/** NUL агуулсан эхний string-ийн зам (буруу бүтэцтэй Unicode-ыг ҮЗЭХГҮЙ). `findUnsafeString` нь хоёуланг хардаг. */
export function findNulPath(root: unknown): PathKey[] | null {
  const found = findUnsafeString(root);
  return found && found.kind === 'NUL' ? found.path : null;
}

/** DTO-г @los/contracts-ийн zod схемээр шалгана; алдаа 400 + issues (stack-гүй). Бие / query / path параметрт NUL (U+0000) эсвэл дан surrogate байвал 400. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const unsafe = findUnsafeString(value);
    if (unsafe) throw new BadRequestException({ statusCode: 400, message: 'Validation failed', issues: [{ code: 'custom', path: unsafe.path, message: MESSAGES[unsafe.kind] }] });
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException({ statusCode: 400, message: 'Validation failed', issues: parsed.error.issues });
    return parsed.data;
  }
}

/** Path параметр (:id, :customerId): хоосон биш, NUL / дан surrogate-гүй string. Тодорхойгүй id нь service дээр 404 болно. */
export const PathParam = new ZodPipe(z.string().min(1));
