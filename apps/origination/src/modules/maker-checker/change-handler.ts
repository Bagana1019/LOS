import type { z } from 'zod';
import type { UserRole } from '@los/contracts';
import type { Actor } from './actor';
import type { ChangeRequestRow, ChangeRequestTx } from './change-request.store';

/** apply() зорилтот өгөгдөл maker-ийн харснаас өөрчлөгдсөн (хуучирсан) гэж үзвэл үүнийг шиднэ → хүсэлт FAILED (MC-BR-7) */
export class ChangeConflictError extends Error {
  constructor(message = 'target changed since the change was proposed') { super(message); this.name = 'ChangeConflictError'; }
}

/**
 * validate() дотроос шиднэ: maker-т харуулах бизнес шалгалтын алдаа → 422 PAYLOAD_INVALID (`message` нь хэрэглэгчид шууд харагдана).
 * Бусад алдаа (DB, сүлжээ, програмын алдаа) 422 болгон хувиргагдахгүй — 500 болж, дэлгэрэнгүй нь зөвхөн лог-д орно.
 */
export class ChangeValidationError extends Error {
  constructor(message: string, readonly details?: unknown) { super(message); this.name = 'ChangeValidationError'; }
}

export interface HandlerPolicyDefaults {
  /** Anhdagch: 4 нүд идэвхтэй эсэх. alwaysFourEyes бол үл хамаарна */
  enabled: boolean;
  checkerRoles: readonly UserRole[];
  expiresInHours: number;
}

export interface SnapshotContext {
  db: unknown; repo: ChangeRequestTx; orgId: string; targetId: string;
  /** Илгээж буй maker ба шалгагдсан payload (нэмэлт — хуучин handler ашиглахгүй) */
  actor?: Actor; payload?: unknown;
}
export interface SnapshotResult {
  before: unknown;
  baseVersion?: string;
  /**
   * Хүсэлтийн хүрээний салбар (MC-BR-2: BRANCH_MANAGER зөвхөн энэ салбарынхыг шийднэ). Өгөөгүй (undefined) бол maker-ийн салбар — өмнөх зан төлөв.
   * Жишээ: CUSTOMER/UPDATE-д харилцагчийг эзэмшигч салбар. `null` = салбаргүй (салбарын дүр шийдэхгүй, fail-closed).
   */
  scopeBranchId?: string | null;
}

/** Codec-д дамжих зорилтын лавлагаа — шифрийг (AAD) тухайн зорилттой холбоно */
export interface CodecRef { orgId: string; targetType: string; targetId: string }
/**
 * Immutable `change_request.payload/before`-д PII ил текстээр орохгүйн тулд (docs/05 §8, §9): framework нь хадгалахаас өмнө `seal`,
 * хэрэгжүүлэх/дэлгэрэнгүй харуулахаас өмнө `unseal` дууддаг. `seal`-ийн гаралт нь PII-гүй байх ёстой (жишээ: шифр + талбарын нэрс).
 */
export interface PayloadCodec {
  seal(value: unknown, ref: CodecRef): unknown;
  unseal(stored: unknown, ref: CodecRef): unknown;
}
export interface ApplyContext<P> {
  /** Үндсэн tx handle — handler зөвхөн үүгээр бичнэ (Prisma бол `ctx.db as Prisma.TransactionClient`). Гадагш HTTP/queue дуудахгүй: tx буцаагдаж болно. */
  db: unknown;
  repo: ChangeRequestTx;
  request: ChangeRequestRow;
  payload: P;
  /** FOUR_EYES бол батлагч, DIRECT бол null */
  checker: Actor | null;
}

/** apply() ДУУДАГДААГҮЙ терминал үр дүн: татгалзсан, цуцалсан, хугацаа дууссан, эсвэл apply хуучирсан өгөгдөлд тулж FAILED болсон. */
export type UnappliedOutcome = 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export interface UnappliedContext {
  /** Хүсэлтийн төлөв өөрчлөгдөж буй ИЖИЛ tx-ийн handle (ApplyContext.db-тэй адил) — handler зөвхөн үүгээр бичнэ. */
  db: unknown;
  repo: ChangeRequestTx;
  /** Хаагдсаны дараах мөр (status, checkerComment, failureReason шинэчлэгдсэн) */
  request: ChangeRequestRow;
  outcome: UnappliedOutcome;
  /** REJECTED/FAILED: батлагч, CANCELLED: maker, EXPIRED: null (sweeper/системийн хаалт) */
  actor: Actor | null;
}

/**
 * Домэйн модуль бүр өөрийн "батлуулах ёстой өөрчлөлт" бүрийг handler болгон бүртгэнэ (ChangeHandlerRegistry.register).
 * Бүртгэсний дараа MakerCheckerService.submit/execute нь policy-д тулгуурлан 4 нүдний урсгалд оруулна.
 */
export interface ChangeHandler<P = unknown> {
  readonly targetType: string;
  readonly action: string;
  /** Maker-ийн илгээсэн агуулгыг шалгана; apply-д мөн дахин шалгагдана */
  readonly payloadSchema: z.ZodType<P, z.ZodTypeDef, unknown>;
  /** Энэ өөрчлөлтийг санал болгож болох дүрүүд */
  readonly makerRoles: readonly UserRole[];
  readonly defaultPolicy: HandlerPolicyDefaults;
  /** true бол policy-оор идэвхгүй болгох боломжгүй (жишээ нь policy-г өөрийг нь өөрчлөх) */
  readonly alwaysFourEyes?: boolean;
  /** targetId-г агуулгаас гаргах каноник дүрэм; өгвөл submit-д targetId таарахгүй бол 422 (давхардал хамгаалалтыг тойруулахгүй) */
  canonicalTargetId?(payload: P): string;
  /** Нэмэлт бизнес шалгалт (schema-аас гадуур). Буруу бол `ChangeValidationError` (эсвэл `MakerCheckerError`) шиднэ; өөр алдаа 500 болно. */
  validate?(ctx: { payload: P; actor: Actor; repo: ChangeRequestTx; targetId: string }): Promise<void> | void;
  /** Maker-ийн харж буй төлөв (diff + хуучралт илрүүлэх baseVersion, сонголттой хүрээний салбар) */
  snapshot?(ctx: SnapshotContext): Promise<SnapshotResult | null>;
  /** Өгвөл payload/before шифрлэгдэж хадгалагдана; apply-д тайлагдаад payloadSchema-аар дахин шалгагдана */
  readonly codec?: PayloadCodec;
  /** Өөрчлөлтийг хэрэгжүүлнэ — checker батлах үед (эсвэл DIRECT горимд) нэг tx дотор */
  apply(ctx: ApplyContext<P>): Promise<void>;
  /**
   * Сонголттой. Хүсэлт apply-гүйгээр хаагдахад (татгалзсан/цуцалсан/хугацаа дууссан/FAILED) статус өөрчлөлттэй НЭГ tx-д дуудагдана:
   * handler зорилтдоо тавьсан "хүлээгдэж буй" тэмдэглэгээг (жишээ нь blacklist.pendingSeverity) цэвэрлэх ёстой, эс бөгөөс зорилт мөнхөд pending үлдэнэ.
   * Идэмпотент байх ёстой. Алдаа шидвэл хаалт бүхэлдээ буцаагдана (хүсэлт PENDING хэвээр, алдаа дуудагчид гарна).
   * Дуудагдахгүй тохиолдол: батлагдсан (apply), DIRECT, мөн хугацаа дууссан хүсэлтийг ИЖИЛ tx-д шинэ илгээлт шууд сольж байгаа үед (шинэ хүсэлт зорилтын pending төлвийг өөртөө авна).
   */
  onNotApplied?(ctx: UnappliedContext): Promise<void>;
}

export class ChangeHandlerRegistry {
  private readonly handlers = new Map<string, ChangeHandler<any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  static key(targetType: string, action: string) { return `${targetType}:${action}`; }
  register<P>(handler: ChangeHandler<P>): void {
    const key = ChangeHandlerRegistry.key(handler.targetType, handler.action);
    if (this.handlers.has(key)) throw new Error(`ChangeHandler already registered: ${key}`);
    if (handler.makerRoles.length === 0 || handler.defaultPolicy.checkerRoles.length === 0) throw new Error(`ChangeHandler ${key} needs makerRoles and checkerRoles`);
    this.handlers.set(key, handler);
  }
  get(targetType: string, action: string) { return this.handlers.get(ChangeHandlerRegistry.key(targetType, action)); }
  list() { return [...this.handlers.values()]; }
}
