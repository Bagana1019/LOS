import { Logger } from '@nestjs/common';
import type { DomainEvent, RequestContext, UserRole } from '@los/contracts';
import { FixedClock } from '@los/nest-common';
import { InMemoryApplicationSigningLookup, type SigningApplication } from './application-signing-lookup';
import { ContractSigningService } from './contract-signing.service';
import { FakeEsignGateway } from './fake-esign.gateway';
import { MemoryContractRepository } from './memory-contract.repository';
import type { SendSigningLinkInput, SigningLinkNotifier } from './signing-link-notifier';

// Тестийн нийтлэг fixture (production-д ашиглагдахгүй)

/** Nest-ийн лог тестийн гаралтыг бохирлохгүй байлгана (файл тус бүр тусдаа module registry-тэй тул бусад тестэд нөлөөлөхгүй) */
export function silenceLogs(): void {
  Logger.overrideLogger(false);
}

export const NOW = new Date('2026-10-28T09:00:00.000Z');
export const APPLICATION_ID = 'app-1';
export const GENERATED_FILE_ID = 'file-generated-1';

export function application(overrides: Partial<SigningApplication> = {}): SigningApplication {
  return {
    orgId: 'org-1', applicationId: APPLICATION_ID, officerId: 'officer-1', branchId: 'branch-1', status: 'APPROVED', contractNo: 'B10026102801',
    primaryBorrower: { customerId: 'cust-1', fullName: 'Бат-Эрдэнэ Болд', registerNo: 'УА12345678', phone: '99112233' },
    ...overrides,
  };
}

export function context(role: UserRole | UserRole[] = 'OFFICER', overrides: Partial<RequestContext> = {}): RequestContext {
  return { userId: 'officer-1', roles: Array.isArray(role) ? role : [role], branchId: 'branch-1', orgId: 'org-1', customerId: null, correlationId: 'corr-1', ...overrides };
}

export class RecordingNotifier implements SigningLinkNotifier {
  readonly sent: SendSigningLinkInput[] = [];
  private failure: Error | null = null;

  failNext(error: Error): void {
    this.failure = error;
  }

  async sendLink(input: SendSigningLinkInput): Promise<void> {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    this.sent.push(input);
  }
}

export interface Harness {
  lookup: InMemoryApplicationSigningLookup;
  contracts: MemoryContractRepository;
  gateway: FakeEsignGateway;
  notifier: RecordingNotifier;
  service: ContractSigningService;
  clock: FixedClock;
}

/** Батлагдсан хүсэлт + үүссэн гэрээ бүхий бэлэн орчин */
export function createHarness(options: { application?: Partial<SigningApplication> | null; contract?: boolean } = {}): Harness {
  const clock = new FixedClock(NOW);
  const lookup = new InMemoryApplicationSigningLookup();
  if (options.application !== null) lookup.set(application(options.application));
  const contracts = new MemoryContractRepository(clock);
  if (options.contract !== false) contracts.seed({ applicationId: APPLICATION_ID, orgId: 'org-1', contractNo: 'B10026102801', generatedFileId: GENERATED_FILE_ID });
  const gateway = new FakeEsignGateway();
  const notifier = new RecordingNotifier();
  const service = new ContractSigningService(lookup, contracts, gateway, notifier, clock);
  return { lookup, contracts, gateway, notifier, service, clock };
}

const base = { eventId: '3f1c2a0e-8f4b-4a53-9a57-0c2f6a8f1a11', occurredAt: '2026-10-28T09:05:00.000Z', version: 1 as const, orgId: 'org-1', actorId: null, correlationId: 'corr-1' };

export function signedEvent(contractId: string, overrides: Partial<Extract<DomainEvent, { type: 'ContractSigned' }>> = {}): DomainEvent {
  return {
    ...base, type: 'ContractSigned', signingRequestId: 'sr-1', applicationId: APPLICATION_ID, contractId, contractNo: 'B10026102801', provider: 'TRIDUM',
    signedFileId: 'file-signed-1', signatureFileId: 'file-p7s-1', originalSha256: 'a'.repeat(64), signedSha256: 'b'.repeat(64), signedAt: '2026-10-28T09:04:00.000Z',
    verificationCode: 'K7M2Q9XA4TDB', ...overrides,
  };
}

export function failedEvent(contractId: string, overrides: Partial<Extract<DomainEvent, { type: 'ContractSigningFailed' }>> = {}): DomainEvent {
  return {
    ...base, type: 'ContractSigningFailed', signingRequestId: 'sr-1', applicationId: APPLICATION_ID, contractId, contractNo: 'B10026102801', reason: 'DECLINED', ...overrides,
  };
}

export function requestedEvent(contractId: string): DomainEvent {
  return {
    ...base, type: 'ContractSigningRequested', signingRequestId: 'sr-1', applicationId: APPLICATION_ID, contractId, contractNo: 'B10026102801', linkExpiresAt: '2026-10-31T09:00:00.000Z',
  };
}
