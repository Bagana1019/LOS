import { describe, expect, it } from 'vitest';
import { CannotVoteReason, type ApprovalLevelApprover, type OrgDirectory } from '@los/contracts';
import { hasMessage } from '../../lib/i18n';
import { approversLine, cannotVoteMessage, showCannotVote } from './decision.voters';

// F3-11: шийдвэрийн хуудас «Та энэ түвшний батлагч биш» гэх мэт шалтгааныг, түвшин бүрийн «Батлах эрхтэй: <нэрс>»-ийг харуулна. UUID хэзээ ч харагдахгүй.
const USER_A = '00000000-0000-4000-8000-000000000a01';
const USER_B = '00000000-0000-4000-8000-000000000b02';
const GHOST = 'a3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const dir: OrgDirectory = { branches: {}, users: { [USER_A]: 'Бат Болд', [USER_B]: 'Саруул' } };
const byUser = (userId: string): ApprovalLevelApprover => ({ userId, role: null });
const byRole = (role: string): ApprovalLevelApprover => ({ userId: null, role });

describe('cannotVoteMessage', () => {
  it('шалтгаан бүрт тодорхой монгол мөр', () => {
    expect(cannotVoteMessage('NOT_LEVEL_APPROVER')).toBe('Та энэ түвшний батлагч биш');
    expect(cannotVoteMessage('ALREADY_VOTED')).toBe('Та энэ түвшинд санал өгсөн байна');
    expect(cannotVoteMessage('OWN_APPLICATION')).toBe('Өөрийн үүсгэсэн хүсэлтийг батлах боломжгүй');
    expect(cannotVoteMessage('NOT_IN_APPROVAL')).toBe('Энэ хүсэлт одоогоор санал авах шатанд биш байна');
  });
  it('шалтгаангүй (санал өгч болно) → null', () => expect(cannotVoteMessage(null)).toBeNull());
  it('CannotVoteReason-ий утга бүрт текст байна; түүхий enum / түлхүүр харагдахгүй', () => {
    for (const reason of CannotVoteReason) {
      const msg = cannotVoteMessage(reason);
      expect(msg, reason).toBeTruthy();
      expect(hasMessage(`decide.cannotVote.${reason}`), reason).toBe(true);
      expect(msg).not.toContain(reason);
      expect(msg).not.toContain('decide.');
    }
  });
});

describe('showCannotVote: зөвхөн санал авч буй хүсэлтэд', () => {
  it('IN_APPROVAL + canVote=false → харуулна', () => expect(showCannotVote({ status: 'IN_APPROVAL', canVote: false, cannotVoteReason: 'NOT_LEVEL_APPROVER' })).toBe(true));
  it('canVote=true → харуулахгүй', () => expect(showCannotVote({ status: 'IN_APPROVAL', canVote: true, cannotVoteReason: null })).toBe(false));
  it.each(['DRAFT', 'APPROVED', 'RETURNED'] as const)('%s төлөв: хуудас өөрөө төлвөө хэлдэг тул давтахгүй', (status) => {
    expect(showCannotVote({ status, canVote: false, cannotVoteReason: 'NOT_IN_APPROVAL' })).toBe(false);
  });
});

describe('approversLine', () => {
  it('хэрэглэгчээр томилсон батлагчид → «Батлах эрхтэй: нэр, нэр»', () => {
    expect(approversLine([byUser(USER_A), byUser(USER_B)], dir, false)).toBe('Батлах эрхтэй: Бат Болд, Саруул');
  });
  it('лавлахад байхгүй id → «Тодорхойгүй», UUID хэзээ ч гарахгүй', () => {
    const out = approversLine([byUser(USER_A), byUser(GHOST)], dir, false);
    expect(out).toBe('Батлах эрхтэй: Бат Болд, Тодорхойгүй');
    expect(out).not.toContain(GHOST);
  });
  it('лавлах ачаалж чадаагүй (undefined, ачаалахгүй) → бүгд «Тодорхойгүй», UUID байхгүй', () => {
    const out = approversLine([byUser(USER_A)], undefined, false);
    expect(out).toBe('Батлах эрхтэй: Тодорхойгүй');
    expect(out).not.toContain(USER_A);
  });
  it('лавлах ачаалж байхад UUID биш (түр «—»)', () => {
    const out = approversLine([byUser(USER_A)], undefined, true);
    expect(out).not.toContain(USER_A);
    expect(out).toContain('Батлах эрхтэй:');
  });
  it('дүрээр томилсон → дүрийн монгол шошго (түүхий enum биш)', () => {
    const out = approversLine([byRole('APPROVER'), byRole('BRANCH_MANAGER')], dir, false);
    expect(out).toBe('Батлах эрхтэй: Батлагч, Салбарын захирал');
    expect(out).not.toContain('APPROVER');
  });
  it('үл мэдэгдэх дүр → «Тодорхойгүй» (түлхүүр / түүхий нэр биш)', () => {
    const out = approversLine([byRole('MYSTERY')], dir, false);
    expect(out).toBe('Батлах эрхтэй: Тодорхойгүй');
    expect(out).not.toContain('auth.role');
  });
  it('нэр, дүр холимог', () => {
    expect(approversLine([byUser(USER_A), byRole('APPROVER')], dir, false)).toBe('Батлах эрхтэй: Бат Болд, Батлагч');
  });
  it('батлагч томилоогүй түвшин → тодорхой мөр, хоосон «Батлах эрхтэй:» биш', () => {
    expect(approversLine([], dir, false)).toBe('Батлах эрхтэй хүн томилоогүй байна');
  });
  it('Object.prototype түлхүүртэй id нэр болж гарахгүй', () => {
    expect(approversLine([byUser('__proto__'), byUser('constructor')], dir, false)).toBe('Батлах эрхтэй: Тодорхойгүй, Тодорхойгүй');
  });
  it('давхардсан нэр хэвээр (хоёр өөр хүн нэг нэртэй байж болно) — тоог буруу хасахгүй', () => {
    const twin: OrgDirectory = { branches: {}, users: { [USER_A]: 'Бат', [USER_B]: 'Бат' } };
    expect(approversLine([byUser(USER_A), byUser(USER_B)], twin, false)).toBe('Батлах эрхтэй: Бат, Бат');
  });
});
