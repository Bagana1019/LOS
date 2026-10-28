// Sosco Score — дотоод зээлжих чадварын оноо (0–1000). Логик нь энэ monorepo-д бичигдэнэ (шийдвэр 2026-10-28).
// Оролт: ЗМС/FICO, DTI, орлогын найдвар, BSA дохио, барьцаа, өмнөх зээлийн түүх. Жин, босго — scoring.sosco_model хүснэгтээс (admin).
export interface SoscoInput { ficoScore: number|null; dtiPercent: number|null; incomeReliability: number|null; pendingSuspiciousCount: number; activeLoanCount: number; overdueHistoryMonths: number; ltv: number|null; }
export interface SoscoWeights { fico: number; dti: number; reliability: number; suspicious: number; history: number; ltv: number; }
export interface SoscoResult { score: number; grade: 'A'|'B'|'C'|'D'|'E'; components: Record<string, number>; modelVersion: string; }
export function soscoScore(_i: SoscoInput, _w: SoscoWeights, _modelVersion: string): SoscoResult {
  throw new Error('TODO(M08b): define components, normalise to 0–1000, grade thresholds from sosco_model');
}
