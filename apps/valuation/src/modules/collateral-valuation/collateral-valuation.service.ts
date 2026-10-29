import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { collateralValue, needsOverrideReason, requiresExternalValuation, round2, sameValue, validUntilFrom } from '@los/calc';
import {
  isManualValueAsset,
  type AssetType,
  type CollateralValuationRecord,
  type HaircutResolution,
  type RecordExternalValuationRequest,
  type RequestContext,
  type SaveCollateralValuationRequest,
  type SaveCollateralValuationResponse,
  type ValuationHistoryResponse,
  type ValuationMethod,
  type ValuationSuggestion,
} from '@los/contracts';
import { buildEvent, enqueueOutbox } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { Prisma } from '.prisma/client-valuation';
import { isRealIsoDate, todayUb, ubDayEnd, ubDayStart } from '../../common/dates';
import { advisoryLock } from '../../common/locks';
import { CollateralSuggestionService } from './collateral-suggestion.service';
import { toRecord } from './collateral-valuation.mapper';
import { CollateralValuationRepository } from './collateral-valuation.repository';

type Subject = Pick<SaveCollateralValuationRequest, 'collateralId' | 'applicationId' | 'productId' | 'assetType' | 'description' | 'externalValuationThreshold' | 'validityDays'>;

interface Persist {
  subject: Subject;
  source: 'INTERNAL' | 'EXTERNAL_LICENSED';
  method: ValuationMethod;
  appraiser: string | null;
  licenseNo: string | null;
  valuedAt: Date;
  validUntil: Date;
  marketValue: number;
  suggestion: ValuationSuggestion;
  haircut: HaircutResolution;
  overrideReason: string | null;
  reportFileId: string | null;
  note: string | null;
}

/** FR-14.1 — INVENTORY: the stocktake value is the valuation basis; EQUIPMENT/OTHER and every override are plain MANUAL. */
const manualMethod = (assetType: AssetType): ValuationMethod => (assetType === 'INVENTORY' ? 'INVENTORY_STOCKTAKE' : 'MANUAL');

/** Data minimisation: the valuation side keeps what re-valuation needs, not the street address or free-text locations. */
function minimised(description: Record<string, unknown>): Prisma.InputJsonValue {
  const { location: _location, ...rest } = description;
  const address = rest.address;
  if (address && typeof address === 'object') {
    const { detail: _detail, ...place } = address as Record<string, unknown>;
    return { ...rest, address: place } as Prisma.InputJsonValue;
  }
  return rest as Prisma.InputJsonValue;
}

const invalidField = (path: string, message: string) => new DomainError('VALIDATION_FAILED', 'Оруулсан өгөгдөл буруу', HttpStatus.BAD_REQUEST, [{ path, message }]);

/**
 * FR-14.2, FR-14.3, FR-14.6 — records a valuation (internal or external) and its history.
 * One transaction per valuation: the valuation-side projection of the collateral, the `collateral_valuation` row and the
 * `ValuationCompleted` outbox event (CLAUDE.md §3.2 rule 4). Personal data (plate, owner, register no, appraiser) is never logged.
 */
@Injectable()
export class CollateralValuationService {
  private readonly logger = new Logger(CollateralValuationService.name);

  constructor(
    @Inject(CollateralSuggestionService) private readonly suggestions: CollateralSuggestionService,
    @Inject(CollateralValuationRepository) private readonly repo: CollateralValuationRepository,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /** Internal valuation: the system suggestion is recomputed here (the client's copy is never trusted). */
  async save(ctx: RequestContext, req: SaveCollateralValuationRequest): Promise<SaveCollateralValuationResponse> {
    const now = this.clock.now();
    const { suggestion, haircut } = await this.suggestions.suggest(ctx, req);

    const chosen = req.marketValue ?? suggestion.marketValue;
    if (chosen === null) {
      throw new DomainError('MARKET_VALUE_REQUIRED', 'Систем үнийн санал гаргах боломжгүй байна. Зах зээлийн үнийг оруулна уу', HttpStatus.UNPROCESSABLE_ENTITY, { unavailableReason: suggestion.unavailableReason });
    }
    const marketValue = round2(chosen);
    if (needsOverrideReason({ manualValueAsset: isManualValueAsset(req.assetType), suggestedValue: suggestion.marketValue, finalValue: marketValue }) && !req.overrideReason) {
      throw new DomainError(
        'OVERRIDE_REASON_REQUIRED',
        suggestion.available ? 'Системийн саналаас ялгаатай үнэ оруулсан тул шалтгаанаа бичнэ үү' : 'Систем үнийн санал гаргаагүй тул гараар оруулсан үнийн шалтгааныг бичнэ үү',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    // The reason is kept when the value was changed (or for manual-value assets, where it is the officer's note); a stray reason beside an unchanged suggestion is dropped.
    const followsSuggestion = suggestion.marketValue !== null && sameValue(suggestion.marketValue, marketValue);
    const record = await this.persist(ctx, now, {
      subject: req,
      source: 'INTERNAL',
      method: followsSuggestion ? (suggestion.method ?? manualMethod(req.assetType)) : manualMethod(req.assetType),
      appraiser: null,
      licenseNo: null,
      valuedAt: now,
      validUntil: validUntilFrom(now, req.validityDays),
      marketValue,
      suggestion,
      haircut,
      overrideReason: followsSuggestion ? null : (req.overrideReason ?? null),
      reportFileId: null,
      note: null,
    });
    return { valuation: record, suggestion };
  }

  /** FR-14.3 · external licensed appraisal: the appraiser's figure is taken as given; the report file is mandatory. */
  async recordExternal(ctx: RequestContext, req: RecordExternalValuationRequest): Promise<SaveCollateralValuationResponse> {
    const now = this.clock.now();
    const today = todayUb(now);
    if (!isRealIsoDate(req.valuedAt)) throw invalidField('valuedAt', 'Огноо буруу (YYYY-MM-DD, бодит өдөр байх ёстой)');
    if (req.validUntil !== undefined && !isRealIsoDate(req.validUntil)) throw invalidField('validUntil', 'Огноо буруу (YYYY-MM-DD, бодит өдөр байх ёстой)');
    if (req.valuedAt > today) throw new DomainError('VALUED_AT_IN_FUTURE', 'Үнэлгээний огноо ирээдүйд байж болохгүй', HttpStatus.UNPROCESSABLE_ENTITY);
    if (req.validUntil !== undefined && req.validUntil <= req.valuedAt) {
      throw new DomainError('VALID_UNTIL_INVALID', 'Хүчинтэй хугацаа үнэлгээний огнооноос хойш байх ёстой', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const valuedAt = ubDayStart(req.valuedAt);
    // An explicit "valid until" date holds for that whole day; the default is valuedAt + external validity days.
    const validUntil = req.validUntil === undefined ? validUntilFrom(valuedAt, req.validityDays) : ubDayEnd(req.validUntil);

    const { suggestion, haircut } = await this.suggestions.suggest(ctx, req);
    const record = await this.persist(ctx, now, {
      subject: req,
      source: 'EXTERNAL_LICENSED',
      method: 'EXTERNAL_APPRAISAL',
      appraiser: req.appraiser,
      licenseNo: req.licenseNo ?? null,
      valuedAt,
      validUntil,
      marketValue: round2(req.marketValue),
      suggestion,
      haircut,
      overrideReason: null,
      reportFileId: req.reportFileId,
      note: req.note ?? null,
    });
    return { valuation: record, suggestion };
  }

  /** FR-14.6 · newest first, org-scoped. A collateral without valuations (or an unknown id) has an empty history. */
  async history(ctx: RequestContext, collateralId: string): Promise<ValuationHistoryResponse> {
    const rows = await this.repo.history(ctx.orgId, collateralId);
    return { items: rows.map((r) => toRecord(r, collateralId)) };
  }

  private async persist(ctx: RequestContext, now: Date, p: Persist): Promise<CollateralValuationRecord> {
    const { subject } = p;
    const value = collateralValue(p.marketValue, p.haircut.rate); // FR-14.2: market value × haircut
    const externalRequired = requiresExternalValuation(p.marketValue, subject.externalValuationThreshold);
    const description = minimised(subject.description);

    const row = await this.repo.transaction(async (tx) => {
      await advisoryLock(tx, 'collateral_valuation', ctx.orgId, subject.collateralId); // one writer per collateral: projection upsert cannot race
      const collateralRefId = await this.repo.upsertProjection(tx, {
        orgId: ctx.orgId,
        collateralId: subject.collateralId,
        applicationId: subject.applicationId,
        productId: subject.productId,
        assetType: subject.assetType,
        descriptionJson: description,
        actorId: ctx.userId,
      });
      const saved = await this.repo.insertValuation(tx, {
        orgId: ctx.orgId,
        collateralRefId,
        source: p.source,
        method: p.method,
        appraiser: p.appraiser,
        licenseNo: p.licenseNo,
        valuedAt: p.valuedAt,
        validUntil: p.validUntil,
        marketValue: p.marketValue,
        suggestedValue: p.suggestion.marketValue,
        haircutRate: p.haircut.rate,
        haircutSource: p.haircut.source,
        collateralValue: value,
        // Reproducibility (FR-14.3): the suggestion with its inputs and the haircut resolution at the time. No owner data in there.
        methodJson: { suggestion: p.suggestion, haircut: p.haircut, ...(p.note ? { note: p.note } : {}) } as Prisma.InputJsonValue,
        reportFileId: p.reportFileId,
        overrideReason: p.overrideReason,
        externalRequired,
        actorId: ctx.userId,
      });
      await enqueueOutbox(
        tx,
        buildEvent(
          ctx,
          'ValuationCompleted',
          {
            collateralId: subject.collateralId,
            applicationId: subject.applicationId,
            marketValue: p.marketValue,
            collateralValue: value,
            valuationId: saved.id,
            assetType: subject.assetType,
            source: p.source,
            haircutRate: p.haircut.rate,
            valuedAt: p.valuedAt.toISOString(),
            validUntil: p.validUntil.toISOString(),
            externalRequired,
          },
          now,
        ),
      );
      return saved;
    });

    this.logger.log('collateral_valuation_recorded', { valuationId: row.id, assetType: subject.assetType, source: p.source, method: p.method, haircutSource: p.haircut.source, externalRequired });
    return toRecord(row, subject.collateralId);
  }
}
