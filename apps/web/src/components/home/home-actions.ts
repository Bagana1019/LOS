import type { Permission } from '@los/contracts';
import { MY_APPROVALS_TAB } from '../../features/applications/list-tabs';

/** F0-2: нүүрийн хуудасны нэг үндсэн үйлдэл (CTA) ба "дараагийн алхам" зөвлөмж. */
export type HomeAction =
  | { kind: 'create'; labelKey: string; hintKey: string }
  | { kind: 'link'; href: string; labelKey: string; hintKey: string };

const APPLICATIONS_HREF = '/los/loan-application';

/**
 * Дүрт тохирсон ганц үйлдэл. Шийдвэрийг цэсийг шийддэг эх сурвалжтай ижил — `/auth/me`-ийн `permissions` (ROLE_PERMISSIONS)-оос гаргана:
 * `application:write` (ЗЭЗ) → шинэ хүсэлт үүсгэх; `approval:vote` (Батлагч, Салбарын захирал) → "Миний батлах" таб; бусад → null.
 */
export function homeActionFor(permissions: readonly Permission[]): HomeAction | null {
  if (permissions.includes('application:write')) {
    return { kind: 'create', labelKey: 'shell.home.new_application', hintKey: 'shell.home.new_application_hint' };
  }
  if (permissions.includes('approval:vote')) {
    return { kind: 'link', href: `${APPLICATIONS_HREF}?status=${MY_APPROVALS_TAB}`, labelKey: 'shell.home.approvals', hintKey: 'shell.home.approvals_hint' };
  }
  return null;
}
