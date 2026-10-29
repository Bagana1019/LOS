import { randomUUID } from 'node:crypto';
import { SystemClock, type Clock } from '@los/nest-common';
import type { ContractRecord, ContractRepository, SigningGuard, SigningPatch } from './contract.repository';

/** Тест, local dev-д зориулсан санах ойн repository — PrismaContractRepository-той ижил CAS дүрэмтэй (contract-repository.suite.ts-ээр баталгаажна). */
export class MemoryContractRepository implements ContractRepository {
  private readonly rows = new Map<string, ContractRecord>();

  constructor(private readonly clock: Clock = new SystemClock()) {}

  /** Тестийн өгөгдөл: contract мөрийг (гэрээ үүсгэх модулийн ажлыг орлож) шууд оруулна */
  seed(input: Partial<ContractRecord> & Pick<ContractRecord, 'applicationId'>): ContractRecord {
    const now = this.clock.now();
    const record: ContractRecord = {
      id: randomUUID(), orgId: 'org-1', contractNo: 'CN-0001', templateVersion: null, generatedFileId: null, signedFileId: null, signedAt: null,
      signChannel: 'PAPER', signingRequestId: null, signingStatus: null, signingFailureReason: null, signingSentAt: null, createdAt: now, updatedAt: now,
      ...input,
    };
    this.rows.set(record.applicationId, record);
    return { ...record };
  }

  async getByApplicationId(applicationId: string): Promise<ContractRecord | null> {
    const row = this.rows.get(applicationId);
    return row ? { ...row } : null;
  }

  async updateSigning(applicationId: string, patch: SigningPatch, guard?: SigningGuard): Promise<boolean> {
    const row = this.rows.get(applicationId);
    if (!row || row.signingStatus === 'SIGNED') return false;
    if (guard?.expectedRequestId !== undefined && row.signingRequestId !== guard.expectedRequestId) return false;
    Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), { updatedAt: this.clock.now() });
    return true;
  }
}
