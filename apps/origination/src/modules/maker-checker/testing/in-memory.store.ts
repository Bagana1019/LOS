import type { DomainEvent } from '@los/contracts';
import type { AuditInput } from '@los/database';
import {
  PendingConflictError,
  type ChangeRequestRow, type ChangeRequestStore, type ChangeRequestTx, type DecisionPatch, type HistoryEntry, type HistoryRow,
  type ListFilter, type NewChangeRequest, type PolicyRow,
} from '../change-request.store';
import { matchesInbox } from '../maker-checker.domain';

/** Тестэд handler-ийн бичих "өгөгдлийн сан": tx-тэй хамт commit/rollback хийгдэнэ */
export interface FakeDb { records: Record<string, unknown> }

interface State {
  rows: Map<string, ChangeRequestRow>;
  history: Map<string, HistoryRow[]>;
  policies: Map<string, PolicyRow>;
  outbox: DomainEvent[];
  audit: AuditInput[];
  db: FakeDb;
}
const clone = <T>(v: T): T => structuredClone(v);

/** Бодит Prisma store-той ижил гэрээтэй санах ойн хэрэгжүүлэлт: tx serialize + rollback + нэг-PENDING-нэг-зорилт. */
export class InMemoryChangeRequestStore implements ChangeRequestStore {
  state: State = { rows: new Map(), history: new Map(), policies: new Map(), outbox: [], audit: [], db: { records: {} } };
  private chain: Promise<unknown> = Promise.resolve();

  get db(): FakeDb { return this.state.db; }
  get outbox(): DomainEvent[] { return this.state.outbox; }
  get audit(): AuditInput[] { return this.state.audit; }
  rows(): ChangeRequestRow[] { return [...this.state.rows.values()]; }

  transaction<T>(fn: (tx: ChangeRequestTx) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const backup = clone(this.state);
      try {
        return await fn(new MemTx(this.state));
      } catch (e) {
        this.state = backup;
        throw e;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async getPolicy(orgId: string, t: string, a: string) { return this.state.policies.get(`${orgId}|${t}|${a}`) ?? null; }
  async listPolicies(orgId: string) { return [...this.state.policies.values()].filter((p) => p.orgId === orgId); }
  async getById(orgId: string, id: string) { const r = this.state.rows.get(id); return r && r.orgId === orgId ? clone(r) : null; }
  async getHistory(id: string) { return clone(this.state.history.get(id) ?? []); }

  async list(orgId: string, f: ListFilter) {
    const all = [...this.state.rows.values()].filter((r) => r.orgId === orgId && this.matches(r, f));
    all.sort((a, b) => (f.scope === 'inbox' ? a.expiresAt.getTime() - b.expiresAt.getTime() : b.createdAt.getTime() - a.createdAt.getTime()) || a.id.localeCompare(b.id));
    return { rows: all.slice((f.page - 1) * f.pageSize, f.page * f.pageSize).map(clone), total: all.length };
  }
  async count(orgId: string, f: Pick<ListFilter, 'scope' | 'actor' | 'now'>) {
    return [...this.state.rows.values()].filter((r) => r.orgId === orgId && this.matches(r, f.scope === 'mine' ? { ...f, status: 'PENDING' } : f)).length;
  }

  private matches(r: ChangeRequestRow, f: Pick<ListFilter, 'scope' | 'actor' | 'now'> & Partial<ListFilter>): boolean {
    if (f.targetType && r.targetType !== f.targetType) return false;
    if (f.applicationId && r.applicationId !== f.applicationId) return false;
    switch (f.scope) {
      case 'inbox': return matchesInbox(f.actor, r, f.now);
      case 'mine': return r.makerId === f.actor.userId && (!f.status || r.status === f.status);
      case 'decided': return r.checkerId === f.actor.userId && (!f.status || r.status === f.status);
      case 'all': return !f.status || r.status === f.status;
    }
  }
}

class MemTx implements ChangeRequestTx {
  constructor(private readonly s: State) {}
  get db() { return this.s.db; }

  async lock(orgId: string, id: string) { const r = this.s.rows.get(id); return r && r.orgId === orgId ? clone(r) : null; }

  async lockTarget(orgId: string, targetType: string, targetId: string) {
    // tx-үүд санах ойд цуваа ажилладаг тул түгжээ шаардлагагүй; зөвхөн PENDING мөрийг буцаана
    const r = [...this.s.rows.values()].find((x) => x.status === 'PENDING' && x.orgId === orgId && x.targetType === targetType && x.targetId === targetId);
    return r ? clone(r) : null;
  }

  async insert(row: NewChangeRequest, createdBy: string) {
    if (row.status === 'PENDING') {
      const dup = [...this.s.rows.values()].some((r) => r.status === 'PENDING' && r.orgId === row.orgId && r.targetType === row.targetType && r.targetId === row.targetId);
      if (dup) throw new PendingConflictError();
    }
    const full: ChangeRequestRow = {
      checkerId: null, checkerRoles: [], checkerComment: null, decidedAt: null, failureReason: null, version: 0, updatedAt: row.createdAt, ...row,
    };
    void createdBy;
    this.s.rows.set(full.id, clone(full));
    return clone(full);
  }

  async update(id: string, p: DecisionPatch) {
    const cur = this.s.rows.get(id);
    if (!cur) throw new Error(`no row ${id}`);
    if (cur.status !== 'PENDING') throw new Error(`terminal row ${id} (${cur.status}) cannot be updated`); // DB trigger-ийн дүр эсгэлт
    const { updatedBy, ...rest } = p;
    void updatedBy;
    const next: ChangeRequestRow = { ...cur, ...rest, version: cur.version + 1, updatedAt: p.decidedAt };
    this.s.rows.set(id, clone(next));
    return clone(next);
  }

  async appendHistory(requestId: string, e: HistoryEntry) {
    const list = this.s.history.get(requestId) ?? [];
    list.push({ ...e, data: e.data ?? null, seq: list.length + 1 });
    this.s.history.set(requestId, list);
  }

  async enqueue(event: DomainEvent) { this.s.outbox.push(clone(event)); }
  async audit(entry: AuditInput) { this.s.audit.push(clone(entry)); }

  async lockOverdue(now: Date, limit: number, orgId?: string) {
    return [...this.s.rows.values()].filter((r) => r.status === 'PENDING' && r.expiresAt.getTime() <= now.getTime() && (!orgId || r.orgId === orgId))
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime()).slice(0, limit).map(clone);
  }

  async getPolicy(orgId: string, t: string, a: string) { return this.s.policies.get(`${orgId}|${t}|${a}`) ?? null; }
  async upsertPolicy(p: Omit<PolicyRow, 'updatedAt'>) {
    const prev = this.s.policies.get(`${p.orgId}|${p.targetType}|${p.action}`);
    // updatedAt нь тест бүрт өөр байх ёстой (baseVersion харьцуулалт) — монотон тоолуур
    const stamp = new Date((prev?.updatedAt.getTime() ?? Date.UTC(2026, 0, 1)) + 1000);
    const row: PolicyRow = { ...p, updatedAt: stamp };
    this.s.policies.set(`${p.orgId}|${p.targetType}|${p.action}`, row);
    return row;
  }
}

