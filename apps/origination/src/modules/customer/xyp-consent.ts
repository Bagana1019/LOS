// ХУР-ын иргэний зөвшөөрлийн (нэг удаагийн код) оролдлогын ХЯЗГААР + АУДИТ. Хоёр эрсдэлээс хамгаална:
//  (1) SMS бөмбөгдөлт: ажилтан / скрипт нэг иргэнд олон код илгээх (иргэнд төвөг, SMS-ийн зардал);
//  (2) кодыг таах: 4–8 оронтой кодыг ажилтан оролдож иргэний зөвшөөрлийг тойрох.
// Тоолуур нь `audit_log` өөрөө (давхар хүснэгт, цэвэрлэгээ хэрэггүй): оролдлого бүр аудитад заавал бичигдэх ёстой (зөвшөөрлийн нотолгоо), тоолох нь түүнийг дахин ашиглана.
// Түлхүүр = байгууллага + регистрийн blind index (түүхий регистр, КОД аудитад ХЭЗЭЭ Ч орохгүй). Тоолж + бичих нь регистр тус бүрийн advisory lock дотор → зэрэгцээгээр тойрогдохгүй.
import type { RequestContext } from '@los/contracts';
import { blindIndex, recordAudit } from '@los/database';
import { DomainError } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';

export const XYP_CONSENT_ENTITY = 'XYP_CONSENT';
/** ТААМАГЛАЛ (docs/DECISIONS.md): хязгаарыг нэг регистрээр (ажилтнаар биш) тоолно. */
export const XYP_CONSENT_WINDOW_MS = 15 * 60_000;
export const XYP_OTP_MAX_REQUESTS = 3;
export const XYP_OTP_MAX_VERIFY_ATTEMPTS = 5;

/** Хязгаарт тоологдох үйлдэл (ХУР руу явахаас ӨМНӨ бүртгэгдэнэ: алдаатай / тодорхойгүй дуудлага ч тоологдоно). */
export type ConsentAttempt = 'XYP_OTP_REQUESTED' | 'XYP_OTP_VERIFY_ATTEMPTED';
/** Үр дүн (зөвхөн аудит). */
export type ConsentOutcome = 'XYP_OTP_REJECTED' | 'XYP_CITIZEN_FETCHED';

/** Ажилтан тус бүрийн хязгаар (өөр өөр регистрээр дамжин олон иргэнд SMS илгээх / олон регистрт код таах сүлжээний урьдчилсан хамгаалалт). ТААМАГЛАЛ. */
export const XYP_CONSENT_USER_WINDOW_MS = 60 * 60_000;
export const XYP_OTP_MAX_REQUESTS_PER_USER = 20;
export const XYP_OTP_MAX_VERIFY_ATTEMPTS_PER_USER = 30;

const REGISTER_LIMITS: Record<ConsentAttempt, number> = { XYP_OTP_REQUESTED: XYP_OTP_MAX_REQUESTS, XYP_OTP_VERIFY_ATTEMPTED: XYP_OTP_MAX_VERIFY_ATTEMPTS };
const USER_LIMITS: Record<ConsentAttempt, number> = { XYP_OTP_REQUESTED: XYP_OTP_MAX_REQUESTS_PER_USER, XYP_OTP_VERIFY_ATTEMPTED: XYP_OTP_MAX_VERIFY_ATTEMPTS_PER_USER };
type Actor = Pick<RequestContext, 'orgId' | 'userId' | 'correlationId'>;

const rateLimited = (windowMs: number): DomainError => new DomainError(
  'XYP_OTP_RATE_LIMITED', `Иргэний кодын хүсэлт / оролдлого хэт олон боллоо. ${windowMs / 60_000} минутын дараа дахин оролдоно уу`, 429,
);

/**
 * Хязгаар хэтрээгүй бол оролдлогыг аудитад бүртгэнэ; хэтэрсэн бол 429 `XYP_OTP_RATE_LIMITED` (ХУР-д хүрэхгүй). Хоёр хязгаар: регистр тус бүрт (15 мин) ба ажилтан тус бүрт (60 мин).
 * Түгжээг ҮРГЭЛЖ ижил дарааллаар (ажилтан → регистр) авна: хоёр транзакц эсрэг дарааллаар хүлээж гацахгүй.
 */
export async function claimConsentAttempt(db: PrismaService, actor: Actor, registerNo: string, action: ConsentAttempt, now: Date = new Date()): Promise<void> {
  const entityId = blindIndex(registerNo);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.orgId}:${XYP_CONSENT_ENTITY}:${action}:user:${actor.userId}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.orgId}:${XYP_CONSENT_ENTITY}:${action}:${entityId}`}, 0))`;
    const base = { orgId: actor.orgId, entity: XYP_CONSENT_ENTITY, action };
    const byRegister = await tx.auditLog.count({ where: { ...base, entityId, at: { gte: new Date(now.getTime() - XYP_CONSENT_WINDOW_MS) } } });
    if (byRegister >= REGISTER_LIMITS[action]) throw rateLimited(XYP_CONSENT_WINDOW_MS);
    const byUser = await tx.auditLog.count({ where: { ...base, actorId: actor.userId, at: { gte: new Date(now.getTime() - XYP_CONSENT_USER_WINDOW_MS) } } });
    if (byUser >= USER_LIMITS[action]) throw rateLimited(XYP_CONSENT_USER_WINDOW_MS);
    await recordAudit(tx, { orgId: actor.orgId, entity: XYP_CONSENT_ENTITY, entityId, action, actorId: actor.userId, correlationId: actor.correlationId });
  });
}

export async function recordConsentOutcome(db: PrismaService, actor: Actor, registerNo: string, action: ConsentOutcome): Promise<void> {
  await db.$transaction((tx) => recordAudit(tx, { orgId: actor.orgId, entity: XYP_CONSENT_ENTITY, entityId: blindIndex(registerNo), action, actorId: actor.userId, correlationId: actor.correlationId }));
}
