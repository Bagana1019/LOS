// CLAUDE.md §3.2(4): domain event-ийг бизнес бичилттэй НЭГ транзакцид `scoring.outbox`-д бичнэ; relay worker (M00) Redis Streams руу гаргана.
// Шууд publish хийхгүй. DomainEventPublisher port-ийн adapter-ууд: PrismaEventPublisher (бодит) · InMemoryEventPublisher (тест).
// Event-д зөвхөн id/тоо/төлөв орно — PII (нэр, регистр, данс, гүйлгээний утга) ХЭЗЭЭ Ч оруулахгүй.
import { DomainEvent, StatementImported } from '@los/contracts';
import { randomUUID } from 'node:crypto';
import type { DomainEventPublisher, RequestContext } from './infra.ports';

/** Схемд нийцээгүй event. `issues` нь зөвхөн замууд + zod кодууд (утга ОРОХГҮЙ) */
export class InvalidDomainEventError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid domain event: ${issues.join('; ')}`);
    this.name = 'InvalidDomainEventError';
  }
}

/** @los/contracts-ийн zod DomainEvent схемээр шалгана. Буцаах нь zod-ын цэвэрлэсэн (unknown түлхүүргүй) хуулбар */
export function validateDomainEvent(event: unknown): DomainEvent {
  const parsed = DomainEvent.safeParse(event);
  if (!parsed.success) {
    const describe = (i: (typeof parsed.error.issues)[number]): string =>
      `${i.path.join('.') || '(root)'}: ${i.code}${'expected' in i ? ` (expected ${String(i.expected)})` : ''}`;
    throw new InvalidDomainEventError(parsed.error.issues.map(describe));
  }
  return parsed.data;
}

// ───────────────────────── Prisma ─────────────────────────

/** Prisma транзакцийн клиентийн ашиглагдах хэсэг (`scoring.outbox` = apps/scoring/prisma/schema.prisma `Outbox`) */
interface OutboxTx {
  outbox: {
    createMany(args: { data: Array<{ id: string; type: string; payload: unknown }>; skipDuplicates: boolean }): Promise<unknown>;
  };
}

function hasOutbox(tx: unknown): tx is OutboxTx {
  return typeof tx === 'object' && tx !== null && typeof (tx as Partial<OutboxTx>).outbox?.createMany === 'function';
}

/**
 * Event-ийг шалгаад дамжуулсан транзакцийн клиентээр `outbox`-д бичнэ ({id: eventId, type, payload}).
 *
 * Давхар eventId = idempotent (чимээгүй алгасна). `create` + P2002 барих БИШ `createMany({skipDuplicates})` (ON CONFLICT DO NOTHING)
 * хэрэглэнэ: PostgreSQL-д транзакц доторх unique зөрчил бүх транзакцийг "aborted" болгодог тул алдааг барьсан ч дараагийн
 * бичилтүүд (бизнес мөр) бүгд унадаг. ON CONFLICT нь транзакцийг эвдэхгүй.
 */
export class PrismaEventPublisher implements DomainEventPublisher {
  async enqueue(tx: unknown, event: DomainEvent): Promise<void> {
    const valid = validateDomainEvent(event);
    if (!hasOutbox(tx)) {
      throw new TypeError('PrismaEventPublisher.enqueue: `tx` must be the scoring Prisma transaction client (it has no `outbox` delegate)');
    }
    await tx.outbox.createMany({ data: [{ id: valid.eventId, type: valid.type, payload: valid }], skipDuplicates: true });
  }
}

// ───────────────────────── In-memory (тест) ─────────────────────────

/** `InMemoryEventPublisher.begin()`-ээр үүсэх явцын транзакц: commit хүртэл event-ийг буферлэнэ */
export class InMemoryEventTransaction {
  #state: 'open' | 'committed' | 'rolledBack' = 'open';
  readonly #buffer: DomainEvent[] = [];

  constructor(private readonly sink: (events: DomainEvent[]) => void) {}

  get isOpen(): boolean {
    return this.#state === 'open';
  }
  get pending(): readonly DomainEvent[] {
    return [...this.#buffer];
  }

  /** @internal */
  add(event: DomainEvent): void {
    if (!this.isOpen) throw new Error(`cannot enqueue on a ${this.#state} transaction`);
    this.#buffer.push(event);
  }
  commit(): void {
    if (!this.isOpen) throw new Error(`cannot commit a ${this.#state} transaction`);
    this.#state = 'committed';
    this.sink(this.#buffer.splice(0));
  }
  rollback(): void {
    if (!this.isOpen) return;
    this.#state = 'rolledBack';
    this.#buffer.length = 0;
  }
}

export interface InMemoryEventPublisherOptions {
  /**
   * true бол `begin()`-ээр үүсгээгүй `tx` (жишээ нь InMemoryBsaRepository-ийн тэмдэг) дээр ч event-ийг `pending`-д буферлэж,
   * `commit()` / `rollback()` хүртэл ил гаргахгүй (rollback симуляци). Анхдагч false: шууд бүртгэнэ.
   */
  buffered?: boolean;
}

/**
 * Тестэд зориулсан publisher. Prisma-тай адил: schema шалгана, давхар eventId-г алгасна (idempotent).
 * Коммит хийгдсэн event-үүд `events`-д, хийгдээгүй нь `pending`-д.
 */
export class InMemoryEventPublisher implements DomainEventPublisher {
  readonly #committed: DomainEvent[] = [];
  readonly #pending: DomainEvent[] = [];
  readonly #ids = new Set<string>();
  readonly #buffered: boolean;

  constructor(options: InMemoryEventPublisherOptions = {}) {
    this.#buffered = options.buffered ?? false;
  }

  get events(): readonly DomainEvent[] {
    return [...this.#committed];
  }
  /** Коммит хийгдээгүй (buffered горимын) event-үүд */
  get pending(): readonly DomainEvent[] {
    return [...this.#pending];
  }

  eventsOfType<T extends DomainEvent['type']>(type: T): Array<Extract<DomainEvent, { type: T }>> {
    return this.#committed.filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type);
  }

  async enqueue(tx: unknown, event: DomainEvent): Promise<void> {
    const valid = validateDomainEvent(event);
    if (tx instanceof InMemoryEventTransaction) tx.add(valid);
    else if (this.#buffered) this.#pending.push(valid);
    else this.#commit([valid]);
  }

  /** Тусдаа транзакц (олон зэрэгцээ "транзакц"-ыг дуурайх). commit() хүртэл `events`-д орохгүй */
  begin(): InMemoryEventTransaction {
    return new InMemoryEventTransaction((events) => this.#commit(events));
  }

  /** `fn` амжилттай бол commit, шидвэл rollback (алдаа дахин шидэгдэнэ) */
  async runInTransaction<T>(fn: (tx: InMemoryEventTransaction) => Promise<T>): Promise<T> {
    const tx = this.begin();
    try {
      const result = await fn(tx);
      tx.commit();
      return result;
    } catch (e) {
      tx.rollback();
      throw e;
    }
  }

  /** buffered горим: хүлээгдэж буй event-үүдийг коммит хийнэ */
  commit(): void {
    this.#commit(this.#pending.splice(0));
  }
  rollback(): void {
    this.#pending.length = 0;
  }

  /**
   * buffered горим: гадаад транзакц (жишээ `repo.runInTransaction`)-ыг ороож, амжилттай бол commit(), шидвэл rollback().
   * `await publisher.scope(() => repo.runInTransaction(async (r, tx) => { …; await publisher.enqueue(tx, ev); }))`
   */
  async scope<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.commit();
      return result;
    } catch (e) {
      this.rollback();
      throw e;
    }
  }

  clear(): void {
    this.#committed.length = 0;
    this.#pending.length = 0;
    this.#ids.clear();
  }

  #commit(events: DomainEvent[]): void {
    for (const e of events) {
      if (this.#ids.has(e.eventId)) continue; // outbox PK-тэй адил idempotent
      this.#ids.add(e.eventId);
      this.#committed.push(e);
    }
  }
}

// ───────────────────────── Event builder ─────────────────────────

/** Event үүсгэхэд хэрэгтэй контекст. `RequestContext` шууд таарна; worker (хэрэглэгчгүй)-д `userId` үгүй → actorId = null */
export type EventContext = Pick<RequestContext, 'orgId' | 'correlationId'> & { userId?: string | null };

/** Тестэд тогтмол uuid / цаг шахах */
export interface EventBuildDeps {
  uuid?: () => string;
  now?: () => Date;
}

export type StatementImportedEvent = Extract<DomainEvent, { type: 'StatementImported' }>;

export interface StatementImportedInput {
  analysisId: string;
  applicationId: string;
  /** Импортлогдсон гүйлгээний мөрийн тоо (FAILED үед 0 байж болно) */
  rows: number;
  status: StatementImportedEvent['status'];
  ctx: EventContext;
}

/** `StatementImported` (CLAUDE.md §3.3) event үүсгэнэ. Схемд нийцэхгүй бол InvalidDomainEventError */
export function buildStatementImportedEvent(input: StatementImportedInput, deps: EventBuildDeps = {}): StatementImportedEvent {
  const problems: string[] = [];
  if (!input.analysisId) problems.push('analysisId: empty');
  if (!input.applicationId) problems.push('applicationId: empty');
  if (!Number.isInteger(input.rows) || input.rows < 0) problems.push('rows: must be a non-negative integer');
  if (problems.length > 0) throw new InvalidDomainEventError(problems);
  const candidate = {
    eventId: (deps.uuid ?? randomUUID)(),
    type: 'StatementImported',
    version: 1,
    occurredAt: (deps.now ?? (() => new Date()))().toISOString(),
    orgId: input.ctx.orgId,
    actorId: input.ctx.userId ?? null,
    correlationId: input.ctx.correlationId,
    analysisId: input.analysisId,
    applicationId: input.applicationId,
    rows: input.rows,
    status: input.status,
  };
  const parsed = StatementImported.safeParse(candidate);
  if (!parsed.success) throw new InvalidDomainEventError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`));
  return parsed.data;
}
