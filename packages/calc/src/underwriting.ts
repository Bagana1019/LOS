// FR-8 / BR-1..5: A цалин (ӨОХ ≤ maxDti), B бизнес (ӨТЧХ ≥ minDscr), C хосолсон. Утга hardcode хийхгүй — policy параметрээр.
// Дэлгэрэнгүй томьёо, тоймлолтын дүрэм: docs/05-scoring-sosco.md §2.
import type { ScoreRequest, UnderwriteResult } from '@los/contracts';

export function underwrite(_req: ScoreRequest): UnderwriteResult {
  throw new Error('TODO(M08): implement per FR-8.1..8.6, BR-1..BR-5');
}
