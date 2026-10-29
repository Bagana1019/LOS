import { SigningFailureReason, SigningStatus } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import {
  deriveStep,
  formatCountdown,
  formatVerificationCode,
  isTerminalStep,
  KNOWN_APP_SCHEMES,
  parseExtraSchemes,
  POLL_ERROR_CAP_MS,
  POLL_FAST_MS,
  POLL_SLOW_AFTER_MS,
  POLL_SLOW_MS,
  pollIntervalMs,
  remainingMs,
  safeDeepLink,
  stepForError,
  type FlowStep,
} from './flow';
import { sessionFixture } from './testing/fixtures';

describe('deriveStep', () => {
  const flags = [false, true] as const;

  it('PENDING: documentViewed ба "Үргэлжлүүлэх" хоёулаа баймагц л сонголт; үгүй бол унших алхам', () => {
    for (const viewed of flags) {
      for (const ack of flags) {
        const step = deriveStep(sessionFixture({ status: 'PENDING', documentViewed: viewed }), ack);
        expect(step, `viewed=${viewed} ack=${ack}`).toEqual(viewed && ack ? { step: 'choose', retryReason: null } : { step: 'review' });
      }
    }
  });

  it('PENDING: серверт гэрээг үзсэн тэмдэггүй бол "дарсан" гэсэн орон нутгийн баталгаа хүрэлцэхгүй', () => {
    expect(deriveStep(sessionFixture({ documentViewed: false }), true)).toEqual({ step: 'review' });
  });

  it('PENDING + өмнөх оролдлогын шалтгаан (provider session унасан): гэрээг дахин уншуулалгүй шууд дахин сонгоно', () => {
    for (const reason of SigningFailureReason) {
      for (const ack of flags) {
        expect(deriveStep(sessionFixture({ documentViewed: true, failureReason: reason }), ack)).toEqual({ step: 'choose', retryReason: reason });
      }
    }
    // Гэрээг үзээгүй бол шалтгаан байсан ч унших алхам
    expect(deriveStep(sessionFixture({ documentViewed: false, failureReason: 'PROVIDER_ERROR' }), true)).toEqual({ step: 'review' });
  });

  it('төлөв бүр documentViewed/ack-ийн бүх хослолд хариу өгнө, PENDING-ээс бусад нь тэднээс хамаарахгүй', () => {
    const expected: Record<Exclude<SigningStatus, 'PENDING'>, FlowStep> = {
      IN_PROGRESS: { step: 'waiting', phase: 'approve' },
      FINALIZING: { step: 'waiting', phase: 'finalizing' },
      SIGNED: { step: 'signed' },
      DECLINED: { step: 'declined' },
      EXPIRED: { step: 'expired' },
      CANCELLED: { step: 'cancelled' },
      FAILED: { step: 'failed', reason: null },
    };
    for (const status of SigningStatus) {
      if (status === 'PENDING') continue;
      for (const viewed of flags) {
        for (const ack of flags) {
          expect(deriveStep(sessionFixture({ status, documentViewed: viewed }), ack), `${status} viewed=${viewed} ack=${ack}`).toEqual(expected[status]);
        }
      }
    }
  });

  it('FAILED: failureReason-ийг алхамд дамжуулна', () => {
    for (const reason of SigningFailureReason) {
      expect(deriveStep(sessionFixture({ status: 'FAILED', failureReason: reason }), true)).toEqual({ step: 'failed', reason });
    }
  });
});

describe('stepForError / isTerminalStep', () => {
  it('404 → notFound, 410 → expired; түр алдаа алхам тодорхойлохгүй', () => {
    expect(stepForError('NOT_FOUND')).toEqual({ step: 'notFound' });
    expect(stepForError('GONE')).toEqual({ step: 'expired' });
    for (const kind of ['RATE_LIMITED', 'CONFLICT', 'INVALID_REQUEST', 'SERVER', 'NETWORK', 'INVALID_RESPONSE'] as const) {
      expect(stepForError(kind), kind).toBeNull();
    }
  });

  it('зөвхөн review/choose/waiting дуусаагүй', () => {
    const open: FlowStep[] = [{ step: 'review' }, { step: 'choose', retryReason: null }, { step: 'waiting', phase: 'approve' }, { step: 'waiting', phase: 'finalizing' }];
    const closed: FlowStep[] = [
      { step: 'signed' },
      { step: 'declined' },
      { step: 'expired' },
      { step: 'cancelled' },
      { step: 'failed', reason: 'PROVIDER_ERROR' },
      { step: 'failed', reason: null },
      { step: 'notFound' },
    ];
    expect(open.map(isTerminalStep)).toEqual(open.map(() => false));
    expect(closed.map(isTerminalStep)).toEqual(closed.map(() => true));
  });
});

describe('pollIntervalMs', () => {
  const waiting: FlowStep = { step: 'waiting', phase: 'approve' };

  it('эхний 60 секунд 2 с, дараа нь 5 с', () => {
    expect(pollIntervalMs(waiting, { elapsedMs: 0 })).toBe(POLL_FAST_MS);
    expect(pollIntervalMs(waiting, { elapsedMs: POLL_SLOW_AFTER_MS - 1 })).toBe(2_000);
    expect(pollIntervalMs(waiting, { elapsedMs: POLL_SLOW_AFTER_MS })).toBe(POLL_SLOW_MS);
    expect(pollIntervalMs(waiting, { elapsedMs: 10 * 60_000 })).toBe(5_000);
  });

  it('finalizing ч мөн polling хийнэ', () => {
    expect(pollIntervalMs({ step: 'waiting', phase: 'finalizing' }, { elapsedMs: 0 })).toBe(2_000);
  });

  it('waiting биш бүх алхамд (болон алхамгүй үед) polling зогсоно', () => {
    const others: FlowStep[] = [
      { step: 'review' },
      { step: 'choose', retryReason: null },
      { step: 'signed' },
      { step: 'declined' },
      { step: 'expired' },
      { step: 'cancelled' },
      { step: 'failed', reason: null },
      { step: 'notFound' },
    ];
    for (const step of others) expect(pollIntervalMs(step, { elapsedMs: 0 }), step.step).toBe(false);
    expect(pollIntervalMs(null, { elapsedMs: 0 })).toBe(false);
  });

  it('дараалсан алдаанд давхар болгон ухарч, 20 с-ээс хэтрэхгүй', () => {
    expect(pollIntervalMs(waiting, { elapsedMs: 0, failures: 1 })).toBe(4_000);
    expect(pollIntervalMs(waiting, { elapsedMs: 0, failures: 2 })).toBe(8_000);
    expect(pollIntervalMs(waiting, { elapsedMs: 0, failures: 3 })).toBe(16_000);
    expect(pollIntervalMs(waiting, { elapsedMs: 0, failures: 4 })).toBe(POLL_ERROR_CAP_MS);
    expect(pollIntervalMs(waiting, { elapsedMs: POLL_SLOW_AFTER_MS, failures: 50 })).toBe(POLL_ERROR_CAP_MS);
  });

  it('429-ийн Retry-After-аас богино болохгүй', () => {
    expect(pollIntervalMs(waiting, { elapsedMs: 0, failures: 1, retryAfterMs: 30_000 })).toBe(30_000);
    expect(pollIntervalMs(waiting, { elapsedMs: 0, failures: 1, retryAfterMs: 1_000 })).toBe(4_000);
    expect(pollIntervalMs(waiting, { elapsedMs: 0, retryAfterMs: null })).toBe(2_000);
  });
});

describe('safeDeepLink', () => {
  it('http(s) болон мэдэгдэж буй апп scheme-ийг зөвшөөрнө', () => {
    expect(safeDeepLink('https://app.tridum.mn/sign?s=abc')).toBe('https://app.tridum.mn/sign?s=abc');
    expect(safeDeepLink('http://localhost:4000/x')).toBe('http://localhost:4000/x');
    for (const scheme of KNOWN_APP_SCHEMES) {
      expect(safeDeepLink(`${scheme}//sign/TRD-MOCK-1?x=1`), scheme).toBe(`${scheme}//sign/TRD-MOCK-1?x=1`);
    }
    expect(safeDeepLink('mock-tridum://sign/TRD-MOCK-1')).toBe('mock-tridum://sign/TRD-MOCK-1');
  });

  it.each([
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    [' javascript:alert(1)'],
    ['java\nscript:alert(1)'],
    ['java\tscript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
    ['blob:https://evil.example/1'],
    ['about:blank'],
    ['ftp://example.com/x'],
    ['evil-app://steal'],
    ['//evil.example/x'],
    ['/relative/path'],
    ['tridum//no-colon'],
    ['https://user:pass@evil.example/'],
    ['https://user@evil.example/'],
    ['tridum://sign with space'],
    ['tridum://sign\u0000'],
    [''],
  ])('%j → null', (raw) => {
    expect(safeDeepLink(raw)).toBeNull();
  });

  it('null, хэт урт утгыг хүлээж авахгүй', () => {
    expect(safeDeepLink(null)).toBeNull();
    expect(safeDeepLink(`https://example.com/${'a'.repeat(2048)}`)).toBeNull();
  });

  it('тохиргооны нэмэлт scheme зөвшөөрөгдөнө, гэхдээ аюултай нь хэзээ ч', () => {
    expect(safeDeepLink('evil-app://x', ['evil-app:'])).toBe('evil-app://x');
    expect(safeDeepLink('javascript:alert(1)', parseExtraSchemes('javascript'))).toBeNull();
  });
});

describe('parseExtraSchemes', () => {
  it('таслалаар тусгаарласан нэрийг normalize хийж, буруу/аюултайг хасна', () => {
    expect(parseExtraSchemes(' tridumapp , MonPass: ,tri-dum')).toEqual(['tridumapp:', 'monpass:', 'tri-dum:']);
    expect(parseExtraSchemes('javascript,data:,file,x,1bad,a b')).toEqual([]);
    expect(parseExtraSchemes('')).toEqual([]);
    expect(parseExtraSchemes(undefined)).toEqual([]);
  });
});

describe('formatVerificationCode', () => {
  it('12 тэмдэгтийг XXXX-XXXX-XXXX болгоно', () => {
    expect(formatVerificationCode('7K3M9QZ4T8VX')).toBe('7K3M-9QZ4-T8VX');
    expect(formatVerificationCode('7k3m9qz4t8vx')).toBe('7K3M-9QZ4-T8VX');
    expect(formatVerificationCode('7K3M-9QZ4-T8VX')).toBe('7K3M-9QZ4-T8VX');
  });
  it('урт нь буруу бол зөвхөн цэвэрлэнэ', () => {
    expect(formatVerificationCode('ab-12')).toBe('AB12');
  });
});

describe('remainingMs / formatCountdown', () => {
  it('үлдсэн хугацаа сөрөг болохгүй, буруу огноо 0', () => {
    const now = Date.parse('2026-10-28T06:00:00.000Z');
    expect(remainingMs('2026-10-28T06:04:30.000Z', now)).toBe(270_000);
    expect(remainingMs('2026-10-28T05:59:00.000Z', now)).toBe(0);
    expect(remainingMs('not-a-date', now)).toBe(0);
  });
  it('MM:SS (дээш тоймлоно)', () => {
    expect(formatCountdown(270_000)).toBe('04:30');
    expect(formatCountdown(59_001)).toBe('01:00');
    expect(formatCountdown(1)).toBe('00:01');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5)).toBe('00:00');
    expect(formatCountdown(75 * 60_000)).toBe('75:00');
  });
});
