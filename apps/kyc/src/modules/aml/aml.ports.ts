// AML модулийн port-ууд (hexagonal). Prisma хэрэгжүүлэлт нь repository/prisma-*.ts, тестэд in-memory.
import type {
  AmlHit, AmlPolicy, AmlRiskFactor, AmlRiskLevel, AmlSubject, DomainEvent, HitStatus, ScreeningList,
  ScreeningStatus, ScreeningTrigger, UserRole,
} from '@los/contracts';

export const AML_REPOSITORY = Symbol('AML_REPOSITORY');
export const AML_POLICY_PROVIDER = Symbol('AML_POLICY_PROVIDER');
export const PII_CIPHER = Symbol('PII_CIPHER');
export const AML_CLOCK = Symbol('AML_CLOCK');
export const AML_IDS = Symbol('AML_IDS');

/** Регистрийг reversible шифрлэх (CLAUDE.md §6.5). Default: @los/database encryptedField / decryptedField. */
export interface PiiCipher { encrypt(plain: string): string; decrypt(cipher: string): string }
export interface Clock { now(): Date }
export interface IdGenerator { uuid(): string }

/** Бодлого org бүрээр. Default: DEFAULT_AML_POLICY; TODO: origination.settings-ийн SettingsChanged projection. */
export interface AmlPolicyProvider { getPolicy(orgId: string): Promise<AmlPolicy> }

/** Gateway-ийн X-User-Id / X-Roles / X-Correlation-Id толгойгоос (CLAUDE.md §3.2.9). */
export interface Actor { userId: string | null; roles: UserRole[]; correlationId: string }

export type SubjectSnapshot = Omit<AmlSubject, 'registerNo'>;

export interface StoredScreening {
  id: string;
  orgId: string;
  customerId: string;
  applicationId: string | null;
  trigger: ScreeningTrigger;
  status: ScreeningStatus;
  blocking: boolean;
  riskScore: number;
  riskLevel: AmlRiskLevel;
  riskFactors: AmlRiskFactor[];
  subjectName: string;
  registerNoMasked: string;
  registerNoHash: string;
  registerNoEncrypted: string;
  subject: SubjectSnapshot;
  listVersions: Record<string, string>;
  screenedAt: Date;
  screenedBy: string | null;
  correlationId: string;
  hits: AmlHit[];
}

export interface BlacklistProjection {
  /** origination.blacklist.id */
  id: string;
  orgId: string;
  registerNoHash: string;
  customerType: AmlSubject['subjectType'];
  name: string;
  listType: string;
  reasonCode: string;
  isActive: boolean;
  changedAt: Date;
}

/** Шийдвэрийн дараах screening-ийн нэгтгэл + outbox event. Repository транзакц дотор, БҮХ hit-ийн одоогийн төлвөөс гаргуулна. */
export interface ReviewDerivation {
  status: ScreeningStatus;
  blocking: boolean;
  /** Шийдвэрийн дараа дахин бодсон эрсдэл — screening-д хадгална. */
  riskScore: number;
  riskLevel: AmlRiskLevel;
  riskFactors: AmlRiskFactor[];
  /** Outbox-д нэг транзакцид бичигдэнэ (CLAUDE.md §3.2.4); дээрх утгуудаас үүсгэсэн байх ёстой. */
  event: DomainEvent;
}

export interface HitReviewCommand {
  orgId: string;
  hitId: string;
  /** Compare-and-set: зөвхөн энэ төлөвт байгаа hit-ийг шинэчилнэ. */
  expectedStatus: Extract<HitStatus, 'OPEN'>;
  status: Exclude<HitStatus, 'OPEN'>;
  reviewedBy: string;
  reviewedAt: Date;
  comment: string;
  /**
   * Цэвэр функц. Repository үүнийг шийдвэр бичигдсэний ДАРАА, screening-ийн мөрийг түгжсэн транзакц дотор, тухайн screening-ийн
   * бүх hit-ийн одоогийн төлвөөр (зэрэгцээ шийдвэрүүдийг оруулаад) дуудна — ингэснээр хоёр хүн өөр өөр hit-ийг зэрэг шийдвэрлэхэд
   * хуучирсан snapshot-оос бодсон нэгтгэл нь нөгөөгийнхөө үр дүнг дарахгүй.
   */
  derive(hitsAfterDecision: AmlHit[]): ReviewDerivation;
}

export type ProjectionResult = 'APPLIED' | 'DUPLICATE' | 'STALE';

/**
 * saveScreening-ийн өмнөх "сүүлийн" screening өөрчлөгдсөн (зэрэгцээ шалгалт орчихсон) — дуудагч өмнөх төлөвөө дахин уншаад шинээр бодно.
 * Юу ч хадгалагдаагүй.
 */
export class ScreeningRaceError extends Error {
  constructor() {
    super('The latest screening of the customer changed while this one was being computed');
    this.name = 'ScreeningRaceError';
  }
}

export interface SaveScreeningOptions {
  /**
   * Optimistic дугаарлалт: харилцагчийн ОДООГИЙН сүүлийн screening-ийн id (байхгүй бол null) энэтэй тэнцүү байх ёстой, үгүй бол
   * ScreeningRaceError. undefined → шалгахгүй (зөвхөн тест fixture). Шалгалт нь (org, customer)-ийн advisory түгжээ авсны дараа,
   * хадгалахтай НЭГ транзакцид явагдана.
   */
  expectedPreviousId?: string | null;
}

/** applyHitReview-ийн үр дүн. 'not_found' = hit олдсонгүй / өөр org-ынх / буруу id (service өмнө нь findHit хийдэг тул ердийн замд гарахгүй). */
export type ApplyHitReviewResult =
  | { outcome: 'applied'; screening: StoredScreening }
  | { outcome: 'already_reviewed' }
  | { outcome: 'superseded' }
  | { outcome: 'not_found' };

export interface AmlRepository {
  /**
   * screening + hits + outbox event нэг транзакцид. Харилцагч (org, customerId) тутамд цувна (advisory түгжээ: түгжээний дараалал
   * "харилцагчийн түгжээ → screening мөрийн FOR UPDATE" хаа сайгүй ижил).
   */
  saveScreening(screening: StoredScreening, event: DomainEvent, options?: SaveScreeningOptions): Promise<void>;
  findScreening(orgId: string, id: string): Promise<StoredScreening | null>;
  findLatestForCustomer(orgId: string, customerId: string): Promise<StoredScreening | null>;
  findHit(orgId: string, hitId: string): Promise<{ screening: StoredScreening; hit: AmlHit } | null>;
  /** Зөвхөн харилцагч тутмын ОДООГИЙН сүүлийн screening-ийн hit-үүд (шинэ screening-ээр сольсон хуучин screening-ийн hit жагсаалтад орохгүй). */
  listHits(orgId: string, filter: { status?: HitStatus; list?: ScreeningList; limit: number; offset: number }): Promise<{ total: number; items: { screening: StoredScreening; hit: AmlHit }[] }>;
  /**
   * Нэг транзакцид: харилцагчийн түгжээ → screening мөрийн FOR UPDATE → screening одоо ч сүүлийнх эсэхийг шалгах (үгүй бол 'superseded') →
   * hit-ийг compare-and-set (өөр хүн шийдсэн бол 'already_reviewed') → бүх hit-ийг дахин уншиж → cmd.derive → screening-ийн нэгтгэл + outbox.
   * 'applied' дахь screening нь хадгалагдсан (дахин уншсан) screening.
   */
  applyHitReview(cmd: HitReviewCommand): Promise<ApplyHitReviewResult>;
  /** Харилцагч тутмын хамгийн сүүлийн screening; currentVersions-ийн түлхүүр бүрээр listVersions зөрсөн эсвэл байхгүй бол "хуучирсан". screenedAt өсөхөөр (хамгийн хуучин нь эхэнд). */
  findOutdatedLatestScreenings(orgId: string, currentVersions: Record<string, string>, limit: number): Promise<StoredScreening[]>;
  /** processed_events(eventId)-ээр давхардал, changedAt-аар дарааллын хамгаалалт (CLAUDE.md §3.2.6). */
  applyBlacklistProjection(projection: BlacklistProjection, eventId: string): Promise<ProjectionResult>;
  /** Зөвхөн идэвхтэй (isActive=true) бүртгэл. */
  findBlacklistByRegisterHash(orgId: string, registerNoHash: string): Promise<BlacklistProjection[]>;
}
