import { describe, expect, it } from 'vitest';
import { permissionsFor, type UserRole } from '@los/contracts';
import { resolveListTab } from '../../features/applications/list-tabs';
import { hasMessage } from '../../lib/i18n';
import { homeActionFor } from './home-actions';

// F0-2: нүүр хуудасны үндсэн үйлдэл нь дүрийн эрхээс (ROLE_PERMISSIONS → /auth/me permissions) гарна, тусдаа дүрийн жагсаалтгүй.
const forRole = (...roles: UserRole[]) => homeActionFor(permissionsFor(roles));

describe('homeActionFor', () => {
  it('хүсэлт үүсгэх эрхтэй (ЗЭЗ) → "Шинэ хүсэлт" үүсгэх үйлдэл', () => {
    expect(forRole('OFFICER')).toEqual({ kind: 'create', labelKey: 'shell.home.new_application', hintKey: 'shell.home.new_application_hint' });
  });

  it('санал өгөх эрхтэй (Батлагч, Салбарын захирал) → "Миний батлах" таб руу холбоос', () => {
    for (const role of ['APPROVER', 'BRANCH_MANAGER'] as const) {
      expect(forRole(role), role).toEqual({ kind: 'link', href: '/los/loan-application?status=MINE', labelKey: 'shell.home.approvals', hintKey: 'shell.home.approvals_hint' });
    }
  });

  it('холбоос нь жагсаалтын табын шийдвэрлэгчээр жинхэнэ "Миний батлах" таб руу очно', () => {
    const action = forRole('APPROVER');
    if (action?.kind !== 'link') throw new Error('link action expected');
    expect(resolveListTab(new URL(action.href, 'http://los.local').searchParams.get('status'), true)).toBe('MINE');
  });

  it('үндсэн үйлдэл байхгүй дүр (ADMIN, COMPLIANCE) болон эрхгүй → null (нэмэлт зүйл харуулахгүй)', () => {
    expect(forRole('ADMIN')).toBeNull();
    expect(forRole('COMPLIANCE')).toBeNull();
    expect(homeActionFor([])).toBeNull();
  });

  it('хүсэлт үүсгэх ба батлах хоёул байвал үүсгэх нь давамгайлна (нэг л үйлдэл)', () => {
    expect(forRole('OFFICER', 'APPROVER')?.kind).toBe('create');
  });

  it('үйлдэл бүрийн i18n түлхүүр бүртгэлтэй', () => {
    for (const action of [forRole('OFFICER'), forRole('APPROVER')]) {
      expect(action).not.toBeNull();
      expect(hasMessage(action!.labelKey), action!.labelKey).toBe(true);
      expect(hasMessage(action!.hintKey), action!.hintKey).toBe(true);
    }
  });
});
