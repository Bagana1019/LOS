import { SigningFailureReason, SigningStatus } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { staffViewFixture } from '../esign/testing/fixtures';
import { SigningApiError, type SigningApiErrorKind } from './api';
import { errorText, failureLabel, statusLabel } from './messages';
import { toSigningApiError } from './query';
import { availableActions, isActive, panelStatus, STATUS_COLOR, type PanelStatus } from './status';

const ALL: PanelStatus[] = ['NONE', ...SigningStatus];

describe('availableActions', () => {
  it('төлөв бүрт зөвхөн dms-ийн төлвийн машинд зөвшөөрөгдсөн үйлдэл', () => {
    const expected: Record<PanelStatus, { send: boolean; resend: boolean; cancel: boolean }> = {
      NONE: { send: true, resend: false, cancel: false },
      PENDING: { send: false, resend: true, cancel: true },
      IN_PROGRESS: { send: false, resend: true, cancel: true },
      FINALIZING: { send: false, resend: false, cancel: false },
      SIGNED: { send: false, resend: false, cancel: false },
      DECLINED: { send: true, resend: false, cancel: false },
      EXPIRED: { send: true, resend: false, cancel: false },
      FAILED: { send: true, resend: false, cancel: false },
      CANCELLED: { send: true, resend: false, cancel: false },
    };
    for (const status of ALL) expect(availableActions(status), status).toEqual(expected[status]);
  });

  it('идэвхтэй хүсэлт байхад шинээр илгээх (409) боломжгүй', () => {
    for (const status of ALL) {
      const a = availableActions(status);
      if (isActive(status)) expect(a.send, status).toBe(false);
      if (a.resend || a.cancel) expect(isActive(status), status).toBe(true);
    }
  });
});

describe('panelStatus / isActive', () => {
  it('хүсэлт байхгүй бол NONE', () => {
    expect(panelStatus(null)).toBe('NONE');
    expect(panelStatus(staffViewFixture({ status: 'SIGNED' }))).toBe('SIGNED');
  });
  it('PENDING, IN_PROGRESS, FINALIZING л идэвхтэй', () => {
    expect(ALL.filter(isActive)).toEqual(['PENDING', 'IN_PROGRESS', 'FINALIZING']);
  });
});

describe('текст / өнгө', () => {
  it('төлөв бүр монгол нэр, өнгөтэй', () => {
    for (const status of ALL) {
      expect(statusLabel(status), status).toMatch(/[А-Яа-яӨөҮүЁё]/);
      expect(STATUS_COLOR[status], status).toBeDefined();
    }
    expect(STATUS_COLOR.SIGNED).toBe('success');
  });
  it('шалтгаан бүр монгол тайлбартай', () => {
    for (const reason of SigningFailureReason) expect(failureLabel(reason), reason).toMatch(/[А-Яа-яӨөҮүЁё]/);
  });
  it('errorText: backend-ийн тайлбарыг эхэлж, үгүй бол төрлөөр', () => {
    expect(errorText(new SigningApiError('CONFLICT', 409, 'Хүсэлт батлагдаагүй'))).toBe('Хүсэлт батлагдаагүй');
    const kinds: SigningApiErrorKind[] = ['NETWORK', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'INVALID_REQUEST', 'SERVER', 'INVALID_RESPONSE'];
    for (const kind of kinds) expect(errorText(new SigningApiError(kind)), kind).toMatch(/[А-Яа-яӨөҮүЁё]/);
  });
  it('toSigningApiError: үл мэдэгдэх алдааг INVALID_REQUEST болгоно', () => {
    const err = new SigningApiError('SERVER', 500);
    expect(toSigningApiError(err)).toBe(err);
    expect(toSigningApiError(new Error('x')).kind).toBe('INVALID_REQUEST');
  });
});
