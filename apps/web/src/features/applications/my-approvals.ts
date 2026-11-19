import { VoteRequest, type ApprovalDecision } from '@los/contracts';
import { ApiError } from '../../lib/api';

/** Санал өгөгчийн ХАРСАН түвшин / хувилбар (жагсаалтын мөр, шийдвэрийн хуудас). Сервер зөрвөл 409 VOTE_TARGET_CHANGED. */
export interface VoteTarget { levelNo?: number; version?: number }

/**
 * FR-1.5: мөр бүрийн Батлах / Буцаах-ын биеийг БАЙГАА санал өгөх API-ийн дүрмээр (`VoteRequest`) бүтээнэ — Буцаахад тайлбар заавал
 * (хоосон, зөвхөн зайтай, 1000-аас урт бол null → илгээхгүй). `target` нь харсан түвшин, хувилбар: хоцрогдсон жагсаалтаас өөр шийдвэрт санал өгөхгүй.
 * Буруу (0, бутархай, NaN) target нь null. Эцсийн шалгалт (өөрийн хүсэлтийг батлахгүй, түвшний гишүүн, хоцрогдсон эсэх) сервер дээр.
 */
export function buildVoteRequest(decision: ApprovalDecision, comment?: string, target: VoteTarget = {}): VoteRequest | null {
  const trimmed = comment?.trim();
  const parsed = VoteRequest.safeParse({
    decision,
    ...(trimmed ? { comment: trimmed } : {}),
    ...(target.levelNo !== undefined ? { levelNo: target.levelNo } : {}),
    ...(target.version !== undefined ? { version: target.version } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Серверийн 409 (VOTE_TARGET_CHANGED, NOT_IN_APPROVAL, ALREADY_VOTED) — харсан төлөв хоцорсон. Жагсаалтыг шинэчилж, хуучин шалтгаантай
 * "Буцаах" цонхыг хаана. Бусад алдаа (403, 400, сүлжээ)-д хэрэглэгч бичсэн шалтгаанаа алдахгүй.
 */
export const isStaleVoteError = (e: unknown): boolean => e instanceof ApiError && e.status === 409;
