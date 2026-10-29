import { Inject, Injectable, Logger } from '@nestjs/common';
import { EncumbranceSourceResult, type EncumbranceCheckRequest, type EncumbranceCheckResult, type EncumbranceStatus } from '@los/contracts';
import { Clock, DomainError } from '@los/nest-common';
import { IntegrationNotImplementedError } from '../../integrations/errors';
import {
  ENCUMBRANCE_REGISTRY,
  EncumbranceUnavailableError,
  isEncumbranceAssetType,
  type EncumbranceRegistry,
} from '../../integrations/encumbrance/encumbrance.registry';
import { EncumbranceIncompleteError, combineEncumbranceStatus, normalizeEncumbranceIdentifier, sortSources } from './encumbrance.rules';

const unavailable = (): DomainError =>
  new DomainError(
    'ENCUMBRANCE_UNAVAILABLE',
    'ЗМС/ЭБ-ийн бүртгэл түр ажиллахгүй байна. Ачааллыг шалгаагүй тул хөрөнгийг "цэвэр" гэж үзэхгүй. Хэсэг хугацааны дараа дахин оролдоно уу',
    503,
  );

/** FR-6.6 · Барьцаа хөрөнгийн ачаалал шалгах (ЗМС + ЭБ). Дуудагч: origination (collateral). Дугаарыг лог-д бичихгүй. */
@Injectable()
export class CollateralChecksService {
  private readonly logger = new Logger(CollateralChecksService.name);

  constructor(
    @Inject(ENCUMBRANCE_REGISTRY) private readonly registry: EncumbranceRegistry,
    private readonly clock: Clock,
  ) {}

  async checkEncumbrance(req: EncumbranceCheckRequest): Promise<EncumbranceCheckResult> {
    if (!isEncumbranceAssetType(req.assetType)) {
      throw new DomainError(
        'ENCUMBRANCE_CHECK_NOT_APPLICABLE',
        'Энэ төрлийн хөрөнгөд ЗМС/ЭБ-ээс ачаалал шалгах боломжгүй (шалгагдах төрөл: тээврийн хэрэгсэл, орон сууц, байшин, газар, тоног төхөөрөмж)',
        422,
      );
    }
    const identifier = normalizeEncumbranceIdentifier(req.assetType, req.identifier);
    if (!identifier) throw new DomainError('INVALID_IDENTIFIER', 'Хөрөнгийн дугаар буруу байна', 400);

    let raw: unknown;
    try {
      raw = await this.registry.check(req.assetType, identifier);
    } catch (e) {
      throw this.mapRegistryError(e);
    }

    // Registry-ийн хариуг дахин баталгаажуулна: буруу хэлбэр, дутуу эх сурвалж → "цэвэр" гэж буцаахгүй (fail closed).
    const parsed = EncumbranceSourceResult.array().safeParse(raw);
    if (!parsed.success) {
      this.logger.error('Encumbrance registry returned a malformed response');
      throw unavailable();
    }
    let status: EncumbranceStatus;
    try {
      status = combineEncumbranceStatus(parsed.data);
    } catch (e) {
      if (e instanceof EncumbranceIncompleteError) throw unavailable();
      throw e;
    }
    return { status, sources: sortSources(parsed.data), checkedAt: this.clock.now().toISOString() };
  }

  private mapRegistryError(e: unknown): DomainError {
    if (e instanceof EncumbranceUnavailableError) return unavailable();
    if (e instanceof IntegrationNotImplementedError) {
      return new DomainError('INTEGRATION_NOT_IMPLEMENTED', 'ЗМС/ЭБ-ийн бодит холболт хараахан хийгдээгүй (INTEGRATION_MODE=mock)', 501);
    }
    // Тодорхойгүй алдаа: үр дүнг "цэвэр" гэж буцаах аюултай тул адилхан хаана. Мессеж, stack дугаар агуулж болох тул ЗӨВХӨН алдааны нэрийг лог-д бичнэ.
    this.logger.error(`Encumbrance registry call failed (${e instanceof Error ? e.name : typeof e})`);
    return unavailable();
  }
}
