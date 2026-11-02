import { ScoreOverview, ScorePreviewRequest, ScorePreviewResponse, SelectMethodRequest } from '@los/contracts';
import type { ScoreTerms } from '@los/contracts';
import { originationFetch } from '../../lib/api';

// Gateway-н замаар origination руу (`originationFetch` нь `/origination` угтварыг нэмнэ → `/api/origination/…`).
// origination-ий зам: `/applications/:applicationId/score…` (docs/05-scoring-sosco.md §5). Хариу бүр @los/contracts-ийн zod-оор шалгагдана.
const base = (applicationId: string): string => `/applications/${encodeURIComponent(applicationId)}/score`;

/** application:read. `ScoreOverview`: нөхцөл, хязгаар, саад, сүүлийн тооцоолол, Sosco. */
export const fetchScoreOverview = (applicationId: string, signal?: AbortSignal): Promise<ScoreOverview> =>
  originationFetch(base(applicationId), { schema: ScoreOverview, signal });

/** application:read. Slider (FR-8.3): хадгалахгүй. Хязгаараас гарвал 422 `OUT_OF_PRODUCT_LIMITS`. */
export const previewScore = async (applicationId: string, body: ScorePreviewRequest, signal?: AbortSignal): Promise<ScorePreviewResponse> =>
  originationFetch(`${base(applicationId)}/preview`, { method: 'POST', json: ScorePreviewRequest.parse(body), schema: ScorePreviewResponse, signal });

/** application:write. Хүсэлтийн хадгалсан нөхцөлөөр (алхам 4) тооцоолж хадгална; body байхгүй. */
export const calculateScore = (applicationId: string): Promise<ScoreOverview> =>
  originationFetch(`${base(applicationId)}/calculate`, { method: 'POST', schema: ScoreOverview });

/** application:write. 409 `CALCULATION_STALE`, 422 `METHOD_NOT_APPLICABLE`. `reason` хоосон бол явуулахгүй (Q-M8-8: заавал биш). */
export const selectScoreMethod = async (applicationId: string, body: SelectMethodRequest): Promise<ScoreOverview> =>
  originationFetch(`${base(applicationId)}/selection`, { method: 'PUT', json: SelectMethodRequest.parse(body), schema: ScoreOverview });

/** Slider-ийн утга → preview body (гурван талбарыг тодорхой явуулна) */
export const previewBody = (t: ScoreTerms): ScorePreviewRequest => ({ amount: t.amount, termMonths: t.termMonths, interestRate: t.interestRate });
