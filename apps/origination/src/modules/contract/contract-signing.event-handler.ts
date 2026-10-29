import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, SigningFailureReason, SigningStatus } from '@los/contracts';
import { CONTRACT_REPOSITORY, type ContractRepository, type SigningPatch } from './contract.repository';

// FR-11.4: dms-ийн ContractSigned / ContractSigningFailed event-ийг contract мөрөнд тусгана.
// G4 олголтын хаалга нь `contract.signed_file_id`-аар шалгана — ContractSigned энэ талбарыг тавьснаар (PAPER скантай адил) олголт нээгдэнэ.
//
// processed_events хүснэгтгүйгээр идемпотент, дарааллаас үл хамаарах байдал (at-least-once хүргэлт):
//  * stale: event-ийн signingRequestId нь contract-ийн ОДООГИЙН signing_request_id-аас өөр бол (өмнөх/давхардсан хүсэлт) үл тоомсорлоно
//  * SIGNED-ийг хэзээ ч бууруулахгүй (repository түвшинд атомар хамгаалсан) · давтан ирсэн event нь өөрчлөлтгүй (no-op)
type SigningEvent = Extract<DomainEvent, { type: 'ContractSigned' | 'ContractSigningFailed' }>;

/** ContractSigningFailed.reason → contract.signing_status */
const FAILURE_STATUS: Record<SigningFailureReason, SigningStatus> = {
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  IDENTITY_MISMATCH: 'FAILED',
  INTEGRITY_ERROR: 'FAILED',
  PROVIDER_ERROR: 'FAILED',
};

@Injectable()
export class ContractSigningEventHandler {
  private readonly logger = new Logger(ContractSigningEventHandler.name);

  constructor(@Inject(CONTRACT_REPOSITORY) private readonly contracts: ContractRepository) {}

  async handle(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case 'ContractSigned':
        return this.apply(event, {
          signingStatus: 'SIGNED', signedFileId: event.signedFileId, signedAt: new Date(event.signedAt), signChannel: 'ESIGN', signingFailureReason: null,
        });
      case 'ContractSigningFailed':
        return this.apply(event, { signingStatus: FAILURE_STATUS[event.reason], signingFailureReason: event.reason });
      default:
        // ContractSigningRequested: PENDING-ийг start() аль хэдийн тэмдэглэсэн. Бусад event энэ модульд хамаагүй.
        return;
    }
  }

  private async apply(event: SigningEvent, patch: SigningPatch): Promise<void> {
    const { applicationId, signingRequestId } = event;
    const contract = await this.contracts.getByApplicationId(applicationId);
    if (!contract || contract.id !== event.contractId || contract.orgId !== event.orgId) {
      this.logger.warn({ event: 'esign.event.ignored', reason: 'contract not found or does not match', type: event.type, applicationId, signingRequestId, eventId: event.eventId });
      return;
    }
    if (contract.signingRequestId !== signingRequestId) {
      this.logger.log({ event: 'esign.event.ignored', reason: 'stale signing request', type: event.type, applicationId, signingRequestId, eventId: event.eventId });
      return;
    }
    if (contract.signingStatus === 'SIGNED') return;
    if (contract.signingStatus === patch.signingStatus && contract.signingFailureReason === patch.signingFailureReason) return;

    // Уншсаны дараа тусдаа хүсэлт (жишээ нь шинэ start) орж ирсэн байж болох тул guard-тай атомар хэрэглэнэ
    const applied = await this.contracts.updateSigning(applicationId, patch, { expectedRequestId: signingRequestId });
    this.logger.log({ event: applied ? 'esign.event.applied' : 'esign.event.lost_race', type: event.type, applicationId, signingRequestId, eventId: event.eventId });
  }
}
