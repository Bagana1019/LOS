import { describe, expect, it } from 'vitest';
import { APPROVAL_VOTER_ROLES, ApplicationStatus } from '@los/contracts';
import { hasMessage, t } from '../../lib/i18n';
import { canSeeMyApprovals, listTabs, MY_APPROVALS_TAB, pendingVoteCount, resolveListTab } from './list-tabs';

// FR-1.1 (M3): төлвийн 9 таб + санал өгөх дүрүүдэд "Миний батлах" таб (тоолууртай).
describe('canSeeMyApprovals — санал өгөх дүр', () => {
  it.each(APPROVAL_VOTER_ROLES)('%s харна', (role) => expect(canSeeMyApprovals([role])).toBe(true));
  it('нэг дүр нь санал өгөх дүр бол хангалттай (олон дүртэй хэрэглэгч)', () => expect(canSeeMyApprovals(['OFFICER', 'APPROVER'])).toBe(true));
  it.each([[['OFFICER']], [['COMPLIANCE']], [[]]])('%j харахгүй', (roles) => expect(canSeeMyApprovals(roles as string[])).toBe(false));
  it('мэдэгдэхгүй дүр / хоосон мөр / undefined-ийг үл тооно', () => {
    expect(canSeeMyApprovals(['', 'ROOT'])).toBe(false);
    expect(canSeeMyApprovals(undefined)).toBe(false);
  });
});

describe('listTabs', () => {
  it('санал өгөхгүй хэрэглэгчид зөвхөн 9 төлвийн таб (өмнөх шигээ)', () => {
    expect(listTabs(false)).toEqual([...ApplicationStatus]);
  });

  it('санал өгөгчид 9 төлөв бүгд хэвээр + "Миний батлах" нэмэгдэнэ, төлвийн дараалал алдагдахгүй', () => {
    const tabs = listTabs(true);
    expect(tabs).toHaveLength(ApplicationStatus.length + 1);
    expect(tabs.filter((k) => k !== MY_APPROVALS_TAB)).toEqual([...ApplicationStatus]);
    expect(tabs.filter((k) => k === MY_APPROVALS_TAB)).toHaveLength(1);
  });

  it('"Миний батлах" нь "Батлах явцад"-ын шууд дараа', () => {
    const tabs = listTabs(true);
    expect(tabs[tabs.indexOf('IN_APPROVAL') + 1]).toBe(MY_APPROVALS_TAB);
  });

  it('таб монгол нэртэй', () => {
    expect(hasMessage('application.list.myApproval')).toBe(true);
    expect(t('application.list.myApproval')).toBe('Миний батлах');
  });
});

describe('resolveListTab — ?status= параметр', () => {
  it('MINE + санал өгөх эрхтэй → "Миний батлах"', () => expect(resolveListTab(MY_APPROVALS_TAB, true)).toBe(MY_APPROVALS_TAB));
  it('MINE + эрхгүй (ЗЭЗ) → ноорог руу буцна (UI-д байхгүй таб руу орохгүй)', () => expect(resolveListTab(MY_APPROVALS_TAB, false)).toBe('DRAFT'));
  it.each(ApplicationStatus)('%s төлөв хэвээр', (s) => {
    expect(resolveListTab(s, true)).toBe(s);
    expect(resolveListTab(s, false)).toBe(s);
  });
  it.each([[null], [''], ['bogus'], ['mine'], ['IN_APPROVAL '], ['__proto__']])('буруу утга %j → DRAFT', (raw) => {
    expect(resolveListTab(raw, true)).toBe('DRAFT');
    expect(resolveListTab(raw, false)).toBe('DRAFT');
  });
});

describe('pendingVoteCount — "Миний батлах" тоолуур', () => {
  it('өөр таб дээр жагсаалтын хариуны myApprovalCount', () => {
    expect(pendingVoteCount({ onMineTab: false, mineTotal: 9, listCount: 3 })).toBe(3);
  });
  it('"Миний батлах" таб дээр шууд ачаалсан жагсаалтын нийт (санал өгсний дараа шинэ байна)', () => {
    expect(pendingVoteCount({ onMineTab: true, mineTotal: 2, listCount: 3 })).toBe(2);
  });
  it('"Миний батлах" таб боловч жагсаалт хараахан ирээгүй бол жагсаалтын тоо руу буцна', () => {
    expect(pendingVoteCount({ onMineTab: true, mineTotal: undefined, listCount: 3 })).toBe(3);
  });
  it('ямар ч өгөгдөл ирээгүй бол 0 (NaN/undefined харагдахгүй)', () => {
    expect(pendingVoteCount({ onMineTab: false, mineTotal: undefined, listCount: undefined })).toBe(0);
    expect(pendingVoteCount({ onMineTab: true, mineTotal: undefined, listCount: undefined })).toBe(0);
  });
  it('0 нь үнэн зөв утга: таб дээр 0 бол жагсаалтын хуучин тоо руу буцахгүй', () => {
    expect(pendingVoteCount({ onMineTab: true, mineTotal: 0, listCount: 5 })).toBe(0);
  });
});
