import type { RequestContext } from '@los/contracts';
import type { Tx } from '../../prisma.service';

/** Батлах урсгал (Модуль 10)-ын порт: application модуль ApprovalModule-ээс хамаарахгүйн тулд токеноор дуудна (цикл үүсгэхгүй). */
export const APPROVAL_FLOW = Symbol('APPROVAL_FLOW');
export interface ApprovalFlowPort {
  /** SUBMITTED → IN_APPROVAL (илгээсэн tx дотор). */
  start(tx: Tx, ctx: RequestContext, applicationId: string): Promise<void>;
  /** "Миний батлах" тоо. */
  myApprovalCount(ctx: RequestContext): Promise<number>;
}
