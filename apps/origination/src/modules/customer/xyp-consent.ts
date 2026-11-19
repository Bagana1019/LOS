// ХУР-ын иргэний зөвшөөрлийн (нэг удаагийн код) оролдлогын ХЯЗГААР + АУДИТ. Хоёр эрсдэлээс хамгаална:
//  (1) SMS бөмбөгдөлт: ажилтан / скрипт нэг иргэнд олон код илгээх (иргэнд төвөг, SMS-ийн зардал);
//  (2) кодыг таах: 4–8 оронтой кодыг ажилтан оролдож иргэний зөвшөөрлийг тойрох.
// Таах оролдлогыг ИЛГЭЭСЭН КОД тус бүрт хязгаарлана (код хүсээгүй бол таах боломжгүй), өдрийн нийт код хүсэлтийг хязгаарлана → регистр тус бүрт өдөрт ≤ 6 код × 3 таамаг.
// Тоолуур нь `audit_log` өөрөө (давхар хүснэгт, цэвэрлэгээ хэрэггүй): оролдлого бүр аудитад заавал бичигдэх ёстой (зөвшөөрлийн нотолгоо), тоолох нь түүнийг дахин ашиглана.
// Түлхүүр = байгууллага + регистрийн blind index (түүхий регистр, КОД аудитад ХЭЗЭЭ Ч орохгүй). Тоолж + бичих нь ажилтан, регистр тус бүрийн advisory lock дотор → зэрэгцээгээр тойрогдохгүй.
import type { RequestContext } from '@los/contracts';
import { blindIndex, recordAudit } from '@los/database';
import { DomainError } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';

export const XYP_CONSENT_ENTITY = 'XYP_CONSENT';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/**
 * Хязгаарууд нь хамгаалалтын ТААМАГЛАЛ (docs/DECISIONS.md), бизнесийн дүрэм БИШ: өөрчлөх бол `setting` руу шилжүүлнэ. ХУР-ын кодын бодит хугацаа, ХУР-ын өөрийн
 * оролдлогын хязгаар тодорхойгүй (VPN-ээр баталгаажуулна).
 */
export const XYP_OTP_MIN_GAP_MS = MINUTE; // UI-ийн «дахин авах» хүлээлттэй ижил — гэхдээ сервер дээр хэрэгжинэ (UI зөвхөн сэнхрүүлнэ)
export const XYP_OTP_WINDOW_MS = 15 * MINUTE; // илгээсэн код хүчинтэй гэж үзэх, мөн хүсэлт тоолох цонх
export const XYP_OTP_MAX_REQUESTS = 3; // регистр тус бүрт XYP_OTP_WINDOW_MS-д
export const XYP_OTP_MAX_REQUESTS_PER_DAY = 6; // регистр тус бүрт 24 цагт
export const XYP_OTP_MAX_ATTEMPTS_PER_CODE = 3; // илгээсэн код тус бүрт
export const XYP_OTP_USER_WINDOW_MS = HOUR; // ажилтан тус бүрт (өөр өөр регистрээр дамжин олон иргэнд SMS / олон регистрт таах)
export const XYP_OTP_MAX_REQUESTS_PER_USER = 20;
export const XYP_OTP_MAX_VERIFY_ATTEMPTS_PER_USER = 30;

/** Хязгаарт тоологдох үйлдэл (ХУР руу явахаас ӨМНӨ бүртгэгдэнэ: алдаатай / тодорхойгүй дуудлага ч тоологдоно). */
export type ConsentAttempt = 'XYP_OTP_REQUESTED' | 'XYP_OTP_VERIFY_ATTEMPTED';
/** Үр дүн (зөвхөн аудит). */
export type ConsentOutcome = 'XYP_OTP_REJECTED' | 'XYP_CITIZEN_FETCHED';

const USER_LIMITS: Record<ConsentAttempt, number> = { XYP_OTP_REQUESTED: XYP_OTP_MAX_REQUESTS_PER_USER, XYP_OTP_VERIFY_ATTEMPTED: XYP_OTP_MAX_VERIFY_ATTEMPTS_PER_USER };
type Actor = Pick<RequestContext, 'orgId' | 'userId' | 'correlationId'>;
type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

const rateLimited = (wait: string): DomainError => new DomainError('XYP_OTP_RATE_LIMITED', `Иргэний кодын хүсэлт / оролдлого хэт олон боллоо. ${wait} дараа дахин оролдоно уу`, 429);
const notRequested = (): DomainError => new DomainError('XYP_OTP_NOT_REQUESTED', 'Иргэний утсанд код илгээгдээгүй эсвэл хугацаа нь дууссан. Эхлээд шинэ код авна уу', 409);
const attemptsExhausted = (): DomainError => new DomainError('XYP_OTP_ATTEMPTS_EXHAUSTED', 'Энэ кодоор оролдох эрх дууслаа. Шинэ код авна уу', 429);

const lock = (tx: Tx, key: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

/**
 * Хязгаар хэтрээгүй бол оролдлогыг аудитад бүртгэнэ; хэтэрсэн бол 429 / 409 (ХУР-д хүрэхгүй).
 *  - код хүсэх: регистр тус бүрт ≥ 1 минутын зай, 15 минутад ≤ 3, 24 цагт ≤ 6; ажилтан тус бүрт цагт ≤ 20;
 *  - код ашиглах: 15 минутад илгээсэн код БАЙХ ёстой (үгүй бол 409), тэр кодод ≤ 3 оролдлого; ажилтан тус бүрт цагт ≤ 30.
 * Түгжээг ҮРГЭЛЖ ижил дарааллаар (ажилтан → регистр) авна: хоёр транзакц эсрэг дарааллаар хүлээж гацахгүй.
 */
export async function claimConsentAttempt(db: PrismaService, actor: Actor, registerNo: string, action: ConsentAttempt, now: Date = new Date()): Promise<void> {
  const entityId = blindIndex(registerNo);
  await db.$transaction(async (tx) => {
    await lock(tx, `${actor.orgId}:${XYP_CONSENT_ENTITY}:${action}:user:${actor.userId}`);
    await lock(tx, `${actor.orgId}:${XYP_CONSENT_ENTITY}:${action}:${entityId}`);
    const ago = (ms: number) => ({ gte: new Date(now.getTime() - ms) });
    const count = (where: Record<string, unknown>) => tx.auditLog.count({ where: { orgId: actor.orgId, entity: XYP_CONSENT_ENTITY, ...where } });

    if (action === 'XYP_OTP_REQUESTED') {
      if ((await count({ action, entityId, at: ago(XYP_OTP_MIN_GAP_MS) })) > 0) throw rateLimited(`${XYP_OTP_MIN_GAP_MS / MINUTE} минутын`);
      if ((await count({ action, entityId, at: ago(XYP_OTP_WINDOW_MS) })) >= XYP_OTP_MAX_REQUESTS) throw rateLimited(`${XYP_OTP_WINDOW_MS / MINUTE} минутын`);
      if ((await count({ action, entityId, at: ago(24 * HOUR) })) >= XYP_OTP_MAX_REQUESTS_PER_DAY) throw rateLimited('24 цагийн');
    } else {
      const issued = await tx.auditLog.findFirst({ where: { orgId: actor.orgId, entity: XYP_CONSENT_ENTITY, entityId, action: 'XYP_OTP_REQUESTED', at: ago(XYP_OTP_WINDOW_MS) }, orderBy: { at: 'desc' }, select: { at: true } });
      if (!issued) throw notRequested();
      if ((await count({ action, entityId, at: { gte: issued.at } })) >= XYP_OTP_MAX_ATTEMPTS_PER_CODE) throw attemptsExhausted();
    }
    if ((await count({ action, actorId: actor.userId, at: ago(XYP_OTP_USER_WINDOW_MS) })) >= USER_LIMITS[action]) throw rateLimited(`${XYP_OTP_USER_WINDOW_MS / MINUTE} минутын`);
    await recordAudit(tx, { orgId: actor.orgId, entity: XYP_CONSENT_ENTITY, entityId, action, actorId: actor.userId, correlationId: actor.correlationId });
  });
}

export async function recordConsentOutcome(db: PrismaService, actor: Actor, registerNo: string, action: ConsentOutcome): Promise<void> {
  await db.$transaction((tx) => recordAudit(tx, { orgId: actor.orgId, entity: XYP_CONSENT_ENTITY, entityId: blindIndex(registerNo), action, actorId: actor.userId, correlationId: actor.correlationId }));
}
