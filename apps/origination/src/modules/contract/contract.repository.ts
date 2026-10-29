import type { SigningFailureReason, SigningStatus } from '@los/contracts';
// docs/03 `contract` (meta) + FR-11.4 цахим гарын үсгийн талбарууд.

export const SignChannel = ['PAPER', 'ESIGN'] as const;
export type SignChannel = typeof SignChannel[number];

export interface ContractRecord {
  id: string;
  orgId: string;
  applicationId: string;
  contractNo: string;
  templateVersion: number | null;
  /** dms.file id — гарын үсэггүй PDF; null бол гэрээ хараахан үүсээгүй */
  generatedFileId: string | null;
  /** G4 олголтын хаалга энэ талбараар шалгана (PAPER скан эсвэл ESIGN-ий PDF) */
  signedFileId: string | null;
  signedAt: Date | null;
  signChannel: SignChannel;
  signingRequestId: string | null;
  signingStatus: SigningStatus | null;
  signingFailureReason: SigningFailureReason | null;
  signingSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `undefined` = өөрчлөхгүй, `null` = цэвэрлэнэ */
export interface SigningPatch {
  signChannel?: SignChannel;
  signingRequestId?: string | null;
  signingStatus?: SigningStatus | null;
  signingFailureReason?: SigningFailureReason | null;
  signingSentAt?: Date | null;
  signedFileId?: string | null;
  signedAt?: Date | null;
}

export interface SigningGuard {
  /** Зөвхөн contract-ийн одоогийн signing_request_id яг энэ байвал хэрэглэнэ (stale хүсэлт/event-ийг хаана) */
  expectedRequestId?: string;
}

export interface ContractRepository {
  getByApplicationId(applicationId: string): Promise<ContractRecord | null>;
  /**
   * Атомар compare-and-set. `signing_status = SIGNED` болсон мөрийг ХЭЗЭЭ Ч өөрчлөхгүй (SIGNED бол төгсгөлийн, downgrade хориотой).
   * `guard.expectedRequestId` өгвөл мөн түүнтэй таарах ёстой. Хэрэглэгдсэн бол true; мөр байхгүй / SIGNED / guard таараагүй бол false.
   */
  updateSigning(applicationId: string, patch: SigningPatch, guard?: SigningGuard): Promise<boolean>;
}
export const CONTRACT_REPOSITORY = Symbol('CONTRACT_REPOSITORY');
