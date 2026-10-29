// Page state that lives in the URL (?tab=&id=) so any view is linkable (NFR-8).
import type { ChangeRequestScope } from '@los/contracts';

export const TAB_KEYS = ['inbox', 'mine', 'decided', 'all', 'policies'] as const;
export type TabKey = (typeof TAB_KEYS)[number];
export const DEFAULT_TAB: TabKey = 'inbox';

export const parseTab = (value: string | null | undefined): TabKey =>
  (TAB_KEYS as readonly string[]).includes(value ?? '') ? (value as TabKey) : DEFAULT_TAB;

/** Every tab except "policies" is a list scope of the same name. */
export const isScopeTab = (tab: TabKey): tab is ChangeRequestScope => tab !== 'policies';

/** A usable request id from the URL or null. Anything odd (blank, too long) is ignored. */
export function parseId(value: string | null | undefined): string | null {
  const id = value?.trim();
  return id && id.length <= 64 ? id : null;
}

export interface PageState {
  tab: TabKey;
  id?: string | null;
}

/** Query string for the page; the default tab is kept explicit so links stay stable. */
export function buildUrl(pathname: string, { tab, id }: PageState): string {
  const q = new URLSearchParams({ tab });
  if (id) q.set('id', id);
  return `${pathname}?${q.toString()}`;
}
