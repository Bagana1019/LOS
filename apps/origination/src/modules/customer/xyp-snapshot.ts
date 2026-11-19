// ХУР-аас иргэний нэг удаагийн кодоор татсан мэдээллийг `POST /customers` хүртэл хадгалах БИТҮҮМЖИЛСЭН тэмдэг (stateless: DB, Redis шаардахгүй).
// Яагаад: иргэний код нэг удаагийнх тул үүсгэх үед ХУР-ыг дахин дуудаж чадахгүй. Харин `source=XYP` үед ХУР-ын талбар ЗЭЗ-ийн утгыг дарж орох ёстой (хуурамч
// овог нэр оруулахаас сэргийлнэ) → сервер өөрийн битүүмжилсэн (AES-GCM, `@los/database` encryptedField) тэмдгийг нээж ХУР-ын мэдээллийг авна.
// Тэмдэг нь агуулгыг нууцалж (маягтад үзүүлснээс өөр юу ч ил биш), хэн / аль байгууллага / аль регистрт зориулагдсанаа AAD-аар баталгаажуулж, 30 мин-д дуусна.
import { XypCitizen, type RequestContext } from '@los/contracts';
import { blindIndex, decryptedField, encryptedField } from '@los/database';
import { DomainError } from '@los/nest-common';

/** ТААМАГЛАЛ (docs/DECISIONS.md): маягт бөглөх, хадгалах хугацаа. Дууссан бол иргэний кодыг дахин авна. */
export const XYP_SNAPSHOT_TTL_MS = 30 * 60_000;

type Scope = Pick<RequestContext, 'orgId' | 'userId'>;

/** AAD: тэмдгийг өөр ажилтан / байгууллага / регистрт ашиглуулахгүй. Регистрийг blind index-ээр (түүхий биш). */
export const xypSnapshotAad = (scope: Scope, registerNo: string): string => `los:xyp-snapshot:v1:${scope.orgId}:${scope.userId}:${blindIndex(registerNo)}`;

const invalid = (): DomainError => new DomainError('XYP_SNAPSHOT_INVALID', 'ХУР-аас татсан мэдээллийн хугацаа дууссан эсвэл хүчингүй байна. Иргэний кодоор дахин татна уу', 400);

export function sealXypSnapshot(scope: Scope, registerNo: string, citizen: XypCitizen, nowMs: number): string {
  return encryptedField(JSON.stringify({ exp: nowMs + XYP_SNAPSHOT_TTL_MS, citizen }), xypSnapshotAad(scope, registerNo));
}

/** Хүчингүй (хугацаа дууссан, засварласан, өөр хэрэглэгч / регистр, бүтэц буруу) бол 400 `XYP_SNAPSHOT_INVALID`; шалтгааныг (түлхүүр, алгоритм) ил гаргахгүй. */
export function openXypSnapshot(scope: Scope, registerNo: string, token: string | undefined, nowMs: number): XypCitizen {
  if (!token) throw invalid();
  let payload: unknown;
  try {
    payload = JSON.parse(decryptedField(token, xypSnapshotAad(scope, registerNo)));
  } catch {
    throw invalid();
  }
  const { exp, citizen } = (payload ?? {}) as { exp?: unknown; citizen?: unknown };
  if (typeof exp !== 'number' || exp < nowMs) throw invalid();
  const parsed = XypCitizen.safeParse(citizen);
  if (!parsed.success || parsed.data.registerNo !== registerNo) throw invalid();
  return parsed.data;
}
