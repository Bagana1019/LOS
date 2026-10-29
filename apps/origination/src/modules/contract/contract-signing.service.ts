import { BadGatewayException, ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SigningSigner, type ApplicationStatus, type ESignProvider, type RequestContext, type SigningRequestView, type SigningStatus } from '@los/contracts';
import { assertInScope, Clock } from '@los/nest-common';
import { APPLICATION_SIGNING_LOOKUP, type ApplicationSigningLookup, type SigningApplication } from './application-signing-lookup';
import { CONTRACT_REPOSITORY, type ContractRecord, type ContractRepository } from './contract.repository';
import { ESIGN_GATEWAY, type EsignGateway, type IssuedSigningRequest } from './esign.gateway';
import { errorName } from './pii';
import { SIGNING_LINK_NOTIFIER, type SigningLinkNotifier } from './signing-link-notifier';
import { toStaffView, type StaffSigningRequestView } from './signing-view';

// FR-11.4 Цахим гарын үсэг — origination тал: өгөгдлийн хүрээ шалгах (NFR-3; эрхийг controller-ийн @Permissions), урьдчилсан нөхцөл, dms руу хүсэлт үүсгэх, SMS линк илгээх, төлвийг contract мөрөнд тусгах.

/** Гэрээнд гарын үсэг зурах боломжтой хүсэлтийн төлвүүд */
const SIGNABLE_STATUSES: readonly ApplicationStatus[] = ['APPROVED', 'DISBURSING'];
/** dms-ийн "идэвхтэй" төлвүүд (тэдгээрт resend/cancel хийж болно) */
const ACTIVE_SIGNING: readonly SigningStatus[] = ['PENDING', 'IN_PROGRESS', 'FINALIZING'];

export interface StartSigningOptions { preferredProvider?: ESignProvider; ttlHours?: number }

@Injectable()
export class ContractSigningService {
  private readonly logger = new Logger(ContractSigningService.name);

  constructor(
    @Inject(APPLICATION_SIGNING_LOOKUP) private readonly applications: ApplicationSigningLookup,
    @Inject(CONTRACT_REPOSITORY) private readonly contracts: ContractRepository,
    @Inject(ESIGN_GATEWAY) private readonly gateway: EsignGateway,
    @Inject(SIGNING_LINK_NOTIFIER) private readonly notifier: SigningLinkNotifier,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /** Гарын үсгийн хүсэлт үүсгэж, зээлдэгчид SMS-ээр линк явуулна. Идэвхтэй хүсэлт байвал 409 (dms хэрэгжүүлнэ). */
  async start(applicationId: string, opts: StartSigningOptions, ctx: RequestContext): Promise<StaffSigningRequestView> {
    const app = await this.loadAuthorized(applicationId, ctx);
    this.assertSignableStatus(app);
    const contract = await this.contracts.getByApplicationId(applicationId);
    if (!contract?.generatedFileId) throw new ConflictException('Гэрээ үүсээгүй байна');
    if (contract.signingStatus === 'SIGNED' || contract.signedFileId !== null) throw new ConflictException('Гэрээнд аль хэдийн гарын үсэг зурагдсан байна');
    if (app.contractNo !== contract.contractNo || app.orgId !== contract.orgId) throw new ConflictException('Гэрээний мэдээлэл хүсэлттэй таарахгүй байна');
    const signer = this.resolveSigner(app);

    const issued = await this.gateway.createRequest({
      applicationId,
      contractId: contract.id,
      contractNo: contract.contractNo,
      sourceFileId: contract.generatedFileId,
      signer,
      preferredProvider: opts.preferredProvider,
      ttlHours: opts.ttlHours,
    }, ctx);
    this.assertViewMatches(issued, app, null);

    // dms-д хүсэлт үүссэн ч өөрийн мөрд тэмдэглэж чадаагүй бол хүсэлт "өнчин" болж (идэвхтэй, гэхдээ бид мэдэхгүй) дараагийн start-ыг 409 болгоно → буцаана
    let recorded = false;
    try {
      recorded = await this.contracts.updateSigning(applicationId, {
        signChannel: 'ESIGN', signingRequestId: issued.id, signingStatus: issued.status, signingFailureReason: null, signingSentAt: null,
      });
    } catch (err) {
      await this.abandon(issued.id, ctx);
      throw err;
    }
    if (!recorded) {
      await this.abandon(issued.id, ctx);
      throw new ConflictException('Гэрээний төлөв өөрчлөгдсөн байна, дахин оролдоно уу');
    }

    this.logger.log({ event: 'esign.requested', applicationId, signingRequestId: issued.id, userId: ctx.userId, correlationId: ctx.correlationId });
    await this.deliverLink(applicationId, issued, signer.phone);
    return toStaffView(issued);
  }

  /** Линкийг шинэчилж (хуучин нь хүчингүй болно) дахин SMS илгээнэ. */
  async resend(applicationId: string, ctx: RequestContext): Promise<StaffSigningRequestView> {
    const app = await this.loadAuthorized(applicationId, ctx);
    this.assertSignableStatus(app);
    const requestId = this.activeRequestId(await this.contracts.getByApplicationId(applicationId));
    const signer = this.resolveSigner(app);

    const issued = await this.gateway.resend(requestId, ctx);
    this.assertViewMatches(issued, app, requestId);
    // Хуучин линк үхсэн тул шинэ линк очтол "илгээсэн" гэж тооцохгүй
    await this.applyView(applicationId, issued, { signingSentAt: null });

    this.logger.log({ event: 'esign.resent', applicationId, signingRequestId: issued.id, userId: ctx.userId, correlationId: ctx.correlationId });
    await this.deliverLink(applicationId, issued, signer.phone);
    return toStaffView(issued);
  }

  async cancel(applicationId: string, ctx: RequestContext): Promise<StaffSigningRequestView> {
    const app = await this.loadAuthorized(applicationId, ctx);
    const requestId = this.activeRequestId(await this.contracts.getByApplicationId(applicationId));

    const view = await this.gateway.cancel(requestId, ctx);
    this.assertViewMatches(view, app, requestId);
    await this.applyView(applicationId, view);

    this.logger.log({ event: 'esign.cancelled', applicationId, signingRequestId: view.id, userId: ctx.userId, correlationId: ctx.correlationId });
    return toStaffView(view);
  }

  async getStatus(applicationId: string, ctx: RequestContext): Promise<StaffSigningRequestView> {
    const app = await this.loadAuthorized(applicationId, ctx);
    const contract = await this.contracts.getByApplicationId(applicationId);
    if (!contract?.signingRequestId) throw new NotFoundException('Цахим гарын үсгийн хүсэлт олдсонгүй');

    const view = await this.gateway.get(contract.signingRequestId, ctx);
    this.assertViewMatches(view, app, contract.signingRequestId);
    return toStaffView(view);
  }

  private async loadAuthorized(applicationId: string, ctx: RequestContext): Promise<SigningApplication> {
    // Өөр байгууллагын хүсэлт нь lookup-д олдохгүй (404); өөрийн байгууллагын боловч хүрээнээс гадуур бол 403 (ЗЭЗ=өөрийн, Салбарын захирал=салбар)
    const app = await this.applications.getForSigning(ctx.orgId, applicationId);
    if (!app) throw new NotFoundException('Хүсэлт олдсонгүй');
    assertInScope(ctx, app);
    return app;
  }

  private assertSignableStatus(app: SigningApplication): void {
    if (!SIGNABLE_STATUSES.includes(app.status)) throw new ConflictException('Хүсэлт батлагдаагүй тул гэрээнд гарын үсэг зурах боломжгүй');
  }

  private activeRequestId(contract: ContractRecord | null): string {
    if (!contract?.signingRequestId || !contract.signingStatus || !ACTIVE_SIGNING.includes(contract.signingStatus)) {
      throw new ConflictException('Идэвхтэй цахим гарын үсгийн хүсэлт байхгүй байна');
    }
    return contract.signingRequestId;
  }

  /** Үндсэн зээлдэгч + утас байх ёстой; утсыг нормчилж DTO-ийн дүрмээр шалгана (dms-ийн 400-аас өмнө ойлгомжтой алдаа өгөх зорилготой) */
  private resolveSigner(app: SigningApplication): SigningSigner {
    const borrower = app.primaryBorrower;
    if (!borrower || !borrower.phone.trim()) throw new ConflictException('Үндсэн зээлдэгч эсвэл утасны дугаар бүртгэлгүй байна');
    const signer = SigningSigner.safeParse({ ...borrower, phone: borrower.phone.replace(/[\s().-]/g, '') });
    if (!signer.success) throw new ConflictException('Зээлдэгчийн регистр эсвэл утасны дугаарын формат буруу байна');
    return signer.data;
  }

  /** dms өөр хүсэлтийн өгөгдлийг буцаавал (эрх шалгасан хүсэлтээс өөр) ажилтанд дамжуулахгүй */
  private assertViewMatches(view: SigningRequestView, app: SigningApplication, expectedId: string | null): void {
    if (view.applicationId !== app.applicationId || view.orgId !== app.orgId || (expectedId !== null && view.id !== expectedId)) {
      throw new BadGatewayException('DMS-ийн хариу хүсэлттэй таарахгүй байна');
    }
  }

  /** dms-ийн төлвийг contract мөрөнд тусгана. SIGNED-ийг зөвхөн ContractSigned event тавина (гарын үсэгтэй файлын id-тай хамт) */
  private async applyView(applicationId: string, view: SigningRequestView, extra: { signingSentAt?: Date | null } = {}): Promise<void> {
    if (view.status === 'SIGNED') return;
    await this.contracts.updateSigning(applicationId, { signingStatus: view.status, signingFailureReason: view.failureReason, ...extra }, { expectedRequestId: view.id });
  }

  private async deliverLink(applicationId: string, issued: IssuedSigningRequest, phone: string): Promise<void> {
    try {
      await this.notifier.sendLink({ applicationId, phone, signingUrl: issued.signingUrl, expiresAt: new Date(issued.linkExpiresAt) });
    } catch (err) {
      // Хүсэлт dms-д идэвхтэй хэвээр — ажилтан "дахин илгээх"-ээр засна. URL/утсыг логлохгүй.
      this.logger.error({ event: 'esign.link.send_failed', applicationId, signingRequestId: issued.id, error: errorName(err) });
      if (err instanceof HttpException) throw err;
      throw new ServiceUnavailableException('Гарын үсгийн холбоосыг зээлдэгчид илгээж чадсангүй. Хүсэлт идэвхтэй байна — "Дахин илгээх" үйлдлийг ашиглана уу');
    }
    await this.contracts.updateSigning(applicationId, { signingSentAt: this.clock.now() }, { expectedRequestId: issued.id });
  }

  /** Best-effort: dms-д үүссэн хүсэлтийг цуцална (өнчин хүсэлт үлдээхгүй) */
  private async abandon(signingRequestId: string, ctx: RequestContext): Promise<void> {
    try {
      await this.gateway.cancel(signingRequestId, ctx);
    } catch (err) {
      this.logger.error({ event: 'esign.abandon_failed', signingRequestId, error: errorName(err), correlationId: ctx.correlationId });
    }
  }
}
