// Label maps and tiny string helpers. All texts live in packages/ui/src/i18n/mn.maker-checker.json.
import { mn } from '@los/ui';
import type { ChangeRequestEvent, ChangeRequestMode, ChangeRequestStatus, MakerCheckerPolicy } from '@los/contracts';

const dict: Record<string, string> = mn;

/** Replace `{name}` placeholders; unknown placeholders are left as they are. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

/** `maker_checker.<group>.<code>` or undefined when that code has no label. */
function lookup(group: string, code: string): string | undefined {
  const key = `maker_checker.${group}.${code}`;
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

export const statusLabel = (s: string): string => lookup('status', s) ?? s;
export const eventLabel = (e: string): string => lookup('event', e) ?? e;
export const modeLabel = (m: string): string => lookup('mode', m) ?? m;
export const roleLabel = (r: string): string => lookup('role', r) ?? r;
export const targetTypeLabel = (t: string): string => lookup('target_type', t) ?? t;
export const changeActionLabel = (a: string): string => lookup('change_action', a) ?? a;

export interface ChangeDescription {
  /** Human title, e.g. "Хар жагсаалтын бүртгэл · Өөрчлөх" or the raw code when nothing is known. */
  title: string;
  /** Raw "TARGET / ACTION" code as secondary text; null when the title already is the raw code. */
  code: string | null;
}

export function describeChange(targetType: string, action: string): ChangeDescription {
  const code = `${targetType} / ${action}`;
  const known = lookup('target_type', targetType) !== undefined || lookup('change_action', action) !== undefined;
  if (!known) return { title: code, code: null };
  return { title: `${targetTypeLabel(targetType)} · ${changeActionLabel(action)}`, code };
}

export const STATUS_COLOR: Record<ChangeRequestStatus, string> = {
  PENDING: 'gold',
  APPLIED: 'green',
  REJECTED: 'red',
  CANCELLED: 'default',
  EXPIRED: 'orange',
  FAILED: 'magenta',
};
export const statusColor = (s: string): string => (Object.hasOwn(STATUS_COLOR, s) ? STATUS_COLOR[s as ChangeRequestStatus] : 'default');

/** Timeline dot colour per audit event. */
export const EVENT_COLOR: Record<ChangeRequestEvent, string> = {
  SUBMITTED: 'blue',
  APPLIED: 'green',
  DIRECT_APPLIED: 'green',
  REJECTED: 'red',
  CANCELLED: 'gray',
  EXPIRED: 'orange',
  FAILED: 'red',
};
export const eventColor = (e: string): string => (Object.hasOwn(EVENT_COLOR, e) ? EVENT_COLOR[e as ChangeRequestEvent] : 'gray');

export const MODE_COLOR: Record<ChangeRequestMode, string> = { FOUR_EYES: 'blue', DIRECT: 'purple' };

/** Roles a policy may require from the checker (mirrors MakerCheckerPolicy.checkerRoles in @los/contracts). */
export type CheckerRole = MakerCheckerPolicy['checkerRoles'][number];
export const CHECKER_ROLES = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'] as const satisfies readonly CheckerRole[];
