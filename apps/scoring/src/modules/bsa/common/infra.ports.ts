// BSA-ийн дэд бүтцийн port-ууд (orchestrator-ын өгсөн spine). Хэрэгжүүлэлт нь `common/` доторх adapter-ууд.
import type { DomainEvent, UserRole } from '@los/contracts';

/** NFR-3: хувийн мэдээлэл (дансны дугаар, гүйлгээний утга, нэр) шифрлэгдэж хадгалагдана. */
export interface PiiCipher {
  /** Тунгалаг бус (opaque) тэмдэгт мөр буцаана; ижил оролтод ялгаатай гаралт (random nonce) */
  encrypt(plain: string): string;
  decrypt(cipherText: string): string;
  /** Тэнцүүгээр хайхад зориулсан тогтмол (deterministic) keyed hash — регистр гэх мэт */
  hash(plain: string): string;
}
export const PII_CIPHER = Symbol('PII_CIPHER');

/** Хуулгын эх файл (MinIO). bsa_import_job.file_id = энэ store-ийн түлхүүр (шийдвэр: dms-ээс хамааралгүй). */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
export const OBJECT_STORE = Symbol('OBJECT_STORE');

/** CLAUDE.md §3.2(4): event-ийг бизнес транзакцтай нэг транзакцид outbox-д бичнэ. `tx` = Prisma транзакцийн клиент. */
export interface DomainEventPublisher {
  enqueue(tx: unknown, event: DomainEvent): Promise<void>;
}
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/** BullMQ (CLAUDE.md §3.1 Job queue). Тест/Redis-гүй орчинд inline хэрэгжүүлэлттэй. */
export interface ImportQueue {
  enqueue(jobId: string, opts?: { attempts?: number }): Promise<void>;
  /** Worker эхлүүлнэ; handler алдаа шидвэл (attempts үлдсэн бол) дахин оролдоно */
  start(handler: (jobId: string) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
export const IMPORT_QUEUE = Symbol('IMPORT_QUEUE');

/** CLAUDE.md §3.2(9): gateway-ийн дамжуулсан толгойгоос; сервис итгэнэ. */
export interface RequestContext {
  /** `X-Org-Id` толгой, байхгүй бол env DEFAULT_ORG_ID */
  orgId: string;
  userId: string;
  roles: UserRole[];
  branchId: string | null;
  correlationId: string;
}

/**
 * BSA-ийн тохиргоо (NFR-6: admin-д тохируулагдана). Эзэмшигч нь origination.settings (CLAUDE.md §3.2(8));
 * origination-ийн projection бэлэн болтол `BsaSettingsProvider` env/анхдагч утга буцаана.
 */
export interface BsaSettings {
  /** BSA-BR-1: ББӨ 0..1 (бүтээгдэхүүнээс ирвэл түүнийг давуу эрхтэй ашиглана) */
  costOfGoodsRate: number;
  /** BSA-BR-2: ӨОХ-ийн дээд хязгаар 0..1 */
  maxDti: number;
  /** BSA-BR-2: Бага/Дунд/Өндөр завсар (таамаг: 0.35 / 0.55 — DECISIONS.md) */
  dtiLevelThresholds: { lowMax: number; mediumMax: number };
  /** BSA-BR-7: "Бусад" ангиллын хувийн босго 0..1 */
  otherShareThreshold: number;
  /** BSA-BR-3 */
  allowedPeriodMonths: number[];
  /** BSA-FR-2.2: хуулгын хамрах хугацаа энэ сараас бага бол "N сарын хуулга дутуу" */
  minStatementMonths: number;
  /** BSA-BR-8 */
  retentionYears: number;
  businessIncomeCodes: string[];
  irregularIncomeCodes: string[];
  reliabilityWeights: { frequency: number; consistency: number; cleanliness: number };
  /** Үлдэгдлийн гинжийн зөвшөөрөх зөрүү (валютаар) */
  balanceTolerance: number;
  /** BSA-FR-5.3: хүлээгдэж буй сэжигтэйтэй шинжилгээг LOS руу татах үед */
  pushPolicyWhenPendingSuspicious: 'WARN' | 'BLOCK';
  maxUploadBytes: number;
  maxFilesPerUpload: number;
}

export interface BsaSettingsProvider {
  get(orgId: string): Promise<BsaSettings>;
}
export const BSA_SETTINGS = Symbol('BSA_SETTINGS');
