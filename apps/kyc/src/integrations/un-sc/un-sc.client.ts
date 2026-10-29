// ӨМЧ: НҮБ-ын Аюулгүйн Зөвлөлийн нэгдсэн хориг арга хэмжээний жагсаалт (UN Security Council Consolidated List).
// Interface + MockUnScClient + RealUnScClient (CLAUDE.md §3.2.7). INTEGRATION_MODE=mock|real.

export type UnPartyType = 'INDIVIDUAL' | 'ENTITY';
export type UnNameQuality = 'PRIMARY' | 'GOOD_ALIAS' | 'LOW_ALIAS';

export interface UnPartyName { value: string; quality: UnNameQuality }
export interface UnPartyIdentifier { type: string; value: string; country?: string }

export interface UnSanctionedParty {
  /** Жагсаалтын бүртгэлийн дугаар (жнь QDi.001). Fixture-д FIXTURE- угтвартай. */
  refId: string;
  type: UnPartyType;
  /** names[0] нь PRIMARY. */
  names: UnPartyName[];
  /** 'YYYY' эсвэл 'YYYY-MM-DD' */
  datesOfBirth: string[];
  nationalities: string[];
  identifiers: UnPartyIdentifier[];
  /** Хориг арга хэмжээний хөтөлбөр / хороо (жнь ISIL_AL_QAIDA, DPRK). */
  programme: string;
  listedOn: string;
  remarks?: string;
}

export interface UnSanctionsSnapshot {
  /** Жагсаалтын хувилбар (UN XML-ийн dateGenerated гэх мэт) — screening бүрт хадгална. */
  version: string;
  publishedAt: string;
  entries: UnSanctionedParty[];
}

export interface UnScClient {
  /** `signal` нь таталтын хугацаа хэтэрсэн (WatchlistService.fetchTimeoutMs) үед abort болно; бодит клиент HTTP дуудлагаа цуцлах ёстой. */
  fetchSnapshot(signal?: AbortSignal): Promise<UnSanctionsSnapshot>;
}
export const UN_SC_CLIENT = Symbol('UN_SC_CLIENT');
