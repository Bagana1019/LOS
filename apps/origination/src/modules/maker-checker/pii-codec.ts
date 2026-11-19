// docs/05-maker-checker.md §8–9: PII-тэй handler-ийн payload/before-ийг immutable мөрөнд шифрлэж хадгалах codec.
// @los/database `encryptedField` (AES-256-GCM, түлхүүр солигдох боломжтой); AAD = org + зорилт → шифрийг өөр зорилтод хуулж болохгүй.
import { z } from 'zod';
import { decryptedField, encryptedField } from '@los/database';
import type { CodecRef, PayloadCodec } from './change-handler';

const Sealed = z.object({ sealed: z.string().min(1), summary: z.unknown().optional() });
const aad = (ref: CodecRef) => `change_request:${ref.orgId}:${ref.targetType}:${ref.targetId}`;

/** @param summarize PII-гүй, уншигдах хураангуй (жишээ нь өөрчлөгдсөн талбарын нэрс) — жагсаалт/inbox-д шифр тайлахгүйгээр харагдана */
export function encryptedJsonCodec(summarize: (value: unknown) => unknown = () => null): PayloadCodec {
  return {
    seal: (value, ref) => ({ sealed: encryptedField(JSON.stringify(value), aad(ref)), summary: summarize(value) }),
    unseal: (stored, ref) => JSON.parse(decryptedField(Sealed.parse(stored).sealed, aad(ref))) as unknown,
  };
}
