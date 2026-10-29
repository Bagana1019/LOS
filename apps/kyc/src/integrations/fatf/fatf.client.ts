// ӨМЧ: FATF-ийн өндөр эрсдэлтэй улсуудын жагсаалт — "Call for Action" (хар жагсаалт) ба "Increased Monitoring" (саарал жагсаалт).
// FATF нь хувь хүнийг биш ЮРИСДИКЦИЙГ жагсаадаг тул тулгалт нь улсын кодоор (ISO 3166-1 alpha-2) хийгдэнэ.
// Interface + MockFatfClient + RealFatfClient (CLAUDE.md §3.2.7). INTEGRATION_MODE=mock|real.
import type { FatfCategory } from '@los/contracts';

export interface FatfJurisdiction {
  /** ISO 3166-1 alpha-2, том үсгээр. */
  countryCode: string;
  countryName: string;
  category: FatfCategory;
  /** FATF-ийн бүрэн хуралдааны огноо (YYYY-MM-DD) */
  listedOn: string;
}

export interface FatfSnapshot {
  /** Жагсаалтын хувилбар, жнь plenary сар: '2026-10'. */
  version: string;
  publishedAt: string;
  entries: FatfJurisdiction[];
}

export interface FatfClient {
  /** `signal` нь таталтын хугацаа хэтэрсэн (WatchlistService.fetchTimeoutMs) үед abort болно; бодит клиент HTTP дуудлагаа цуцлах ёстой. */
  fetchSnapshot(signal?: AbortSignal): Promise<FatfSnapshot>;
}
export const FATF_CLIENT = Symbol('FATF_CLIENT');
