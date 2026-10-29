import { describe, expect, it } from 'vitest';
import { canEditContent, canWriteApplication, editBlockedReason } from './access';

describe('бичих эрх (docs/05 §3)', () => {
  it('OFFICER, ADMIN бичнэ; бусад зөвхөн уншина', () => {
    expect(canWriteApplication(['OFFICER'])).toBe(true);
    expect(canWriteApplication(['ADMIN'])).toBe(true);
    expect(canWriteApplication(['APPROVER', 'OFFICER'])).toBe(true);
    for (const role of ['BRANCH_MANAGER', 'APPROVER', 'AUDITOR']) expect(canWriteApplication([role])).toBe(false);
    expect(canWriteApplication([])).toBe(false);
    expect(canWriteApplication(undefined)).toBe(false);
  });
  it('засах боломж: дүр + төлөв; төлөв тодорхойгүй бол зөвшөөрч сервер шийднэ', () => {
    expect(canEditContent({ canWrite: true, editable: true })).toBe(true);
    expect(canEditContent({ canWrite: true, editable: undefined })).toBe(true);
    expect(canEditContent({ canWrite: true, editable: false })).toBe(false);
    expect(canEditContent({ canWrite: false, editable: true })).toBe(false);
  });
  it('хаагдсан шалтгаан: дүр эхэнд', () => {
    expect(editBlockedReason({ canWrite: false, editable: false })).toBe('role');
    expect(editBlockedReason({ canWrite: true, editable: false })).toBe('status');
    expect(editBlockedReason({ canWrite: true, editable: true })).toBeNull();
    expect(editBlockedReason({ canWrite: true, editable: undefined })).toBeNull();
  });
});
