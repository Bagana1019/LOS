// FR-8 / BR-1..5: A цалин (ӨОХ ≤ maxDti), B бизнес (ӨТЧХ ≥ minDscr), C хосолсон. Утга hardcode хийхгүй — policy параметрээр.
import type { ScoreRequest } from '@los/contracts';
export interface MethodResult { method: 'A_SALARY'|'B_BUSINESS'|'C_COMBINED'; baseIncome: number; ratio: number; ratioKind: 'DTI'|'DSCR'; pass: boolean; maxAffordable: number; reason?: string; }
export interface UnderwritingResult { methods: MethodResult[]; autoSelected: MethodResult['method']; ltv: number; ltvPass: boolean; }
export function underwrite(_req: ScoreRequest): UnderwritingResult {
  throw new Error('TODO(M08): implement per FR-8.1..8.6, BR-1..BR-5');
}
