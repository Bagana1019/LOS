import type { ApplicationStatus } from '@los/contracts';

/** docs/01 §2 — «Олгогдсон зээлүүд»: олгосон (ACTIVE), эхний үлдэгдэлтэй (MIGRATED), хаасан (CLOSED). */
export const LOAN_TABS: readonly ApplicationStatus[] = ['ACTIVE', 'MIGRATED', 'CLOSED'];

export const isLoanTab = (v: string | null): v is ApplicationStatus => !!v && (LOAN_TABS as readonly string[]).includes(v);

export const loanPaymentsHref = (id: string): string => `/los/loan/${encodeURIComponent(id)}/payments`;
