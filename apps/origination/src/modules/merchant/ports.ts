import type { PosScreeningRequest, PosScreeningResponse } from '@los/contracts';
import type { PlanRecord } from './domain/records';

// Гадаад/орчны хамаарал бүр абстракт class (DI token) — mock/real-ийг INTEGRATION_MODE-оор сонгоно (CLAUDE.md §3.2.7).

/** Дотоод дуудлагын tenant хил (PII-гүй): kyc талд org_id-аар хязгаарлаж, аудитлахад `x-org-id` толгойгоор дамжина (CLAUDE.md §3.2.9). */
export interface ScreeningContext { orgId: string }

export abstract class BuyerScreeningPort {
  /**
   * Хувь хүн, хар жагсаалт, PEP, ЗМС, НДШ орлого. Хүрэх боломжгүй бол DomainError('SCREENING_UNAVAILABLE') шиднэ.
   * `context` нь заавал биш (хойшхи нийцтэй): real adapter өгөгдсөн үед tenant толгойг нэмнэ.
   */
  abstract screen(req: PosScreeningRequest, correlationId: string, context?: ScreeningContext): Promise<PosScreeningResponse>;
}
export abstract class SmsGateway {
  abstract send(toPhone: string, text: string): Promise<void>;
}
export abstract class OtpGenerator {
  abstract next(): string;
}
/** Регистр зэрэг PII-г шифрлэх (CLAUDE.md §6.5) ба хайлтын hash. */
export abstract class PiiCipher {
  abstract encrypt(plain: string): string;
  abstract decrypt(cipher: string): string;
  abstract hash(plain: string): string;
}
export abstract class Clock {
  abstract now(): Date;
}
export abstract class IdGenerator {
  abstract uuid(): string;
  /** Лизингийн дугаарын 6 тэмдэгт (Crockford base32, төөрөгдөх тэмдэггүй). */
  abstract leaseSuffix(): string;
}
/** №4 (эрсдэлд суурилсан үнэ)-ийн орох цэг: одоо plan-ийн хүү/шимтгэл. */
export abstract class PricingProvider {
  abstract resolve(plan: PlanRecord): { annualRate: number; feeRate: number };
}
