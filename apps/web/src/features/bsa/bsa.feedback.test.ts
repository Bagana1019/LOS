import { describe, expect, it } from 'vitest';
import type { BsaUploadResponse } from '@los/contracts';
import { ApiError } from '../../lib/http';
import { isPaymentMissing, jobStatusView, parseUploadFailure, resolveFeedback, syncPaymentFeedback, UploadError, uploadErrorFeedback, uploadFeedback, UPLOAD_LIMITS } from './bsa.feedback';

// F6-2 / F6-4 / F6-6 / F6-7 / F6-12: BSA дэлгэцийн үр дүн, алдааны мэдээллийн цэвэр логик.

const accepted = (index: number) => ({ index, status: 'ACCEPTED' as const, jobId: `j${index}`, format: 'PDF' as const });
const duplicate = (index: number) => ({ index, status: 'DUPLICATE' as const, existingJobId: 'old' });
const rejected = (index: number, code: string, message = 'server text') => ({ index, status: 'REJECTED' as const, code, message });
const res = (outcomes: BsaUploadResponse['outcomes']): BsaUploadResponse => ({
  outcomes,
  accepted: outcomes.filter((o) => o.status === 'ACCEPTED').length,
  duplicates: outcomes.filter((o) => o.status === 'DUPLICATE').length,
  rejected: outcomes.filter((o) => o.status === 'REJECTED').length,
});
const uploadError = (status: number, code: string | null, outcomes: BsaUploadResponse['outcomes'] = []) => new UploadError(status, code, 'Unsupported Media Type', outcomes, null);

describe('jobStatusView (F6-6)', () => {
  it('shows a Mongolian label for every import job status, never the raw enum', () => {
    expect(jobStatusView('PENDING').label).toBe('Хүлээгдэж буй');
    expect(jobStatusView('PROCESSING').label).toBe('Боловсруулж буй');
    expect(jobStatusView('COMPLETED').label).toBe('Дууссан');
    expect(jobStatusView('FAILED').label).toBe('Алдаатай');
  });
  it('colours failed red and completed green; an unknown future status falls back to its raw text', () => {
    expect(jobStatusView('FAILED').color).toBe('error');
    expect(jobStatusView('COMPLETED').color).toBe('success');
    expect(jobStatusView('ARCHIVED')).toEqual({ label: 'ARCHIVED', color: 'default' });
  });
});

describe('uploadFeedback (F6-7)', () => {
  it('reports plain success with the accepted count and no detail lines', () => {
    const f = uploadFeedback(res([accepted(0), accepted(1)]), ['a.pdf', 'b.pdf']);
    expect(f.type).toBe('success');
    expect(f.message).toContain('2 файл хүлээн авлаа');
    expect(f.details).toEqual([]);
  });

  it('a duplicate-only upload (server 200 {duplicates:1}) is called out as a warning naming the file, with the next step', () => {
    const f = uploadFeedback(res([duplicate(0)]), ['statement-sep.pdf']);
    expect(f.type).toBe('warning');
    expect(f.message).toContain('өмнө оруулсан');
    expect(f.message).toContain('1 файл');
    expect(f.details.join('\n')).toContain('statement-sep.pdf');
    expect(f.details.join('\n')).toContain('өөр файл');
  });

  it('a mixed upload counts accepted, duplicate and rejected files and explains each non-accepted file', () => {
    const f = uploadFeedback(res([accepted(0), duplicate(1), rejected(2, 'FILE_EMPTY')]), ['ok.pdf', 'dup.pdf', 'empty.pdf']);
    expect(f.type).toBe('warning');
    expect(f.message).toContain('1 файл хүлээн авлаа');
    expect(f.message).toContain('1 файл өмнө оруулсан');
    expect(f.message).toContain('1 файл татгалзлаа');
    const lines = f.details.join('\n');
    expect(lines).toContain('dup.pdf');
    expect(lines).toContain('empty.pdf');
    expect(lines).toContain('Файл хоосон байна');
    expect(lines).not.toContain('ok.pdf');
  });

  it('a rejected outcome with an unknown code falls back to the server message', () => {
    const f = uploadFeedback(res([accepted(0), rejected(1, 'SOMETHING_NEW', 'Шинэ шалтгаан')]), ['a.pdf', 'b.pdf']);
    expect(f.details.join('\n')).toContain('Шинэ шалтгаан');
  });

  it('tolerates an empty outcomes list (older server) by trusting the counters', () => {
    const f = uploadFeedback({ outcomes: [], accepted: 1, duplicates: 0, rejected: 0 }, ['a.pdf']);
    expect(f.type).toBe('success');
    expect(f.message).toContain('1 файл хүлээн авлаа');
  });
});

describe('uploadErrorFeedback (F6-4)', () => {
  const english = /Unsupported|Bad Request|Payload|Service Unavailable|Not Acceptable/i;

  it('415 FILE_UNSUPPORTED -> clear Mongolian, lists the supported formats, no raw HTTP text', () => {
    const f = uploadErrorFeedback(uploadError(415, 'FILE_UNSUPPORTED', [rejected(0, 'FILE_UNSUPPORTED')]), ['virus.exe']);
    expect(f.type).toBe('error');
    expect(f.message).toContain('дэмжигдэхгүй');
    expect(f.message).toContain('PDF');
    expect(f.message).not.toMatch(english);
  });

  it('XLSX is explained separately because the server cannot read it (the finding proposed telling users to upload xlsx, which would fail)', () => {
    const f = uploadErrorFeedback(uploadError(415, 'XLSX_UNSUPPORTED'), ['a.xlsx']);
    expect(f.message).toContain('Excel');
    expect(f.message).toContain('CSV');
  });

  it('keys on the HTTP status when the body had no code (proxy, older server)', () => {
    expect(uploadErrorFeedback(new ApiError(415, null, 'Unsupported Media Type'), ['a.exe']).message).toContain('дэмжигдэхгүй');
    expect(uploadErrorFeedback(new ApiError(413, null, 'Payload Too Large'), ['a.pdf']).message).toContain(`${UPLOAD_LIMITS.maxMb} МБ`);
    expect(uploadErrorFeedback(new ApiError(503, null, 'Service Unavailable'), ['a.pdf']).message).toContain('түр ажиллахгүй');
  });

  it('400 FILE_EMPTY -> "Файл хоосон байна"; a bare 400 gets a Mongolian generic, never "Bad Request"', () => {
    expect(uploadErrorFeedback(uploadError(400, 'FILE_EMPTY', [rejected(0, 'FILE_EMPTY')]), ['empty.pdf']).message).toContain('Файл хоосон байна');
    const bare = uploadErrorFeedback(new ApiError(400, null, 'Bad Request'), ['a.pdf']);
    expect(bare.message).not.toMatch(english);
    expect(bare.message).toContain('Хуулга оруулж чадсангүй');
  });

  it('maps the remaining server codes: too many files, invalid bank, analysis already pushed', () => {
    expect(uploadErrorFeedback(uploadError(400, 'TOO_MANY_FILES'), []).message).toContain(`${UPLOAD_LIMITS.maxFiles}`);
    expect(uploadErrorFeedback(uploadError(400, 'INVALID_BANK'), []).message).toContain('банк');
    expect(uploadErrorFeedback(uploadError(409, 'ANALYSIS_NOT_DRAFT'), []).message).toContain('татагдсан');
  });

  it('when several files were all rejected, one line per file with its own reason', () => {
    const f = uploadErrorFeedback(uploadError(415, 'FILE_UNSUPPORTED', [rejected(0, 'FILE_UNSUPPORTED'), rejected(1, 'FILE_EMPTY')]), ['a.exe', 'b.pdf']);
    expect(f.details).toHaveLength(2);
    expect(f.details[0]).toContain('a.exe');
    expect(f.details[1]).toContain('b.pdf');
    expect(f.details[1]).toContain('Файл хоосон байна');
  });

  it('auth, server and network failures keep the shared Mongolian wording', () => {
    expect(uploadErrorFeedback(new ApiError(500, null, 'Internal Server Error'), []).message).not.toMatch(/Internal Server Error/);
    expect(uploadErrorFeedback(new TypeError('Failed to fetch'), []).message).not.toContain('Failed to fetch');
  });
});

describe('parseUploadFailure', () => {
  it('reads code and per-file outcomes from the error body', () => {
    const e = parseUploadFailure(415, 'Unsupported Media Type', { statusCode: 415, code: 'FILE_UNSUPPORTED', message: 'x', details: { outcomes: [rejected(0, 'FILE_UNSUPPORTED')] } }, 'cid-1');
    expect(e).toBeInstanceOf(UploadError);
    expect(e).toMatchObject({ status: 415, code: 'FILE_UNSUPPORTED', correlationId: 'cid-1' });
    expect(e.outcomes).toHaveLength(1);
  });
  it('survives a non-JSON body (code null, no outcomes, statusText kept as the technical message)', () => {
    const e = parseUploadFailure(502, 'Bad Gateway', null, null);
    expect(e).toMatchObject({ status: 502, code: null, message: 'Bad Gateway', outcomes: [] });
  });
});

describe('syncPaymentFeedback (F6-2)', () => {
  it('an unregistered payment tells the user where to fill it in', () => {
    const f = syncPaymentFeedback({ updated: 0, payment: null, hasAnalysis: true });
    expect(f.type).toBe('warning');
    expect(f.message).toContain('бүртгэгдээгүй');
    expect(f.message).toContain('Зээлийн мэдээлэл');
  });
  it('without any analysis it says to create one first', () => {
    const f = syncPaymentFeedback({ updated: 0, payment: 450_000, hasAnalysis: false });
    expect(f.type).toBe('info');
    expect(f.message).toContain('Шинжилгээ үүсгээгүй');
  });
  it('reports how many analyses were refreshed', () => {
    const f = syncPaymentFeedback({ updated: 2, payment: 450_000, hasAnalysis: true });
    expect(f.type).toBe('success');
    expect(f.message).toContain('2 шинжилгээ');
  });
  it('nothing to change is said explicitly instead of staying silent', () => {
    const f = syncPaymentFeedback({ updated: 0, payment: 450_000, hasAnalysis: true });
    expect(f.type).toBe('info');
    expect(f.message).toContain('өөрчлөх зүйл');
  });
  it('treats null and 0 as a missing payment, positive as present', () => {
    expect([isPaymentMissing(null), isPaymentMissing(0), isPaymentMissing(1)]).toEqual([true, true, false]);
  });
});

describe('resolveFeedback (F6-12)', () => {
  it('states the action and the count', () => {
    expect(resolveFeedback('APPROVE', 3, {})).toContain('3 дохиог зөвшөөрлөө');
    expect(resolveFeedback('EXCLUDE', 1, {})).toContain('1 дохиог тооцооноос хаслаа');
  });
  it('names the new category on reclassify', () => {
    expect(resolveFeedback('RECLASSIFY', 2, { categoryName: 'Зээл (авсан зээлийн олголт)' })).toContain('«Зээл (авсан зээлийн олголт)»');
  });
  it('explains why the rows vanished when the list is filtered to pending', () => {
    expect(resolveFeedback('APPROVE', 1, { pendingFilter: true })).toContain('шүүлтүүр');
    expect(resolveFeedback('APPROVE', 1, { pendingFilter: false })).not.toContain('шүүлтүүр');
  });
});

describe('resolveFeedback impact on transactions (F6-10)', () => {
  const category = 'Зээл (авсан зээлийн олголт)';

  it('says how many transactions changed category and which direction was left alone', () => {
    const msg = resolveFeedback('RECLASSIFY', 1, { categoryName: category, impact: { changed: 1, unchanged: 1, unchangedDirection: 'EXPENSE' } });
    expect(msg).toContain('1 дохионы ангиллыг');
    expect(msg).toContain('1 гүйлгээний ангилал солигдлоо');
    expect(msg).toContain('1 зарлагын гүйлгээ чиглэл таарахгүй тул өөрчлөгдсөнгүй');
  });

  it('names the income direction when the expense side was reclassified', () => {
    const msg = resolveFeedback('RECLASSIFY', 1, { categoryName: 'Зээлийн төлбөр', impact: { changed: 2, unchanged: 3, unchangedDirection: 'INCOME' } });
    expect(msg).toContain('2 гүйлгээний ангилал солигдлоо');
    expect(msg).toContain('3 орлогын гүйлгээ чиглэл таарахгүй тул өөрчлөгдсөнгүй');
  });

  it('says plainly that nothing changed when the signals held no recategorisable transaction', () => {
    const msg = resolveFeedback('EXCLUDE', 1, { impact: { changed: 0, unchanged: 0, unchangedDirection: null } });
    expect(msg).toContain('1 дохиог тооцооноос хаслаа');
    expect(msg).toContain('Гүйлгээний ангилал өөрчлөгдсөнгүй');
    expect(msg).not.toContain('чиглэл таарахгүй');
  });

  it('reports exclude counts without a direction sentence', () => {
    const msg = resolveFeedback('EXCLUDE', 2, { impact: { changed: 4, unchanged: 0, unchangedDirection: null } });
    expect(msg).toContain('4 гүйлгээний ангилал солигдлоо');
  });

  it('leaves approve untouched when no impact is given', () => {
    expect(resolveFeedback('APPROVE', 3, { impact: null })).toBe('3 дохиог зөвшөөрлөө.');
  });

  it('mentions signals the server skipped, so the number the user sees is the resolved one', () => {
    const msg = resolveFeedback('APPROVE', 2, { skipped: 1 });
    expect(msg).toContain('2 дохиог зөвшөөрлөө');
    expect(msg).toContain('1 дохио аль хэдийн шийдвэрлэгдсэн эсвэл олдоогүй тул алгасагдлаа');
    expect(resolveFeedback('APPROVE', 2, { skipped: 0 })).not.toContain('алгасагдлаа');
  });

  it('keeps the pending-filter hint last', () => {
    const msg = resolveFeedback('EXCLUDE', 1, { pendingFilter: true, skipped: 1, impact: { changed: 1, unchanged: 0, unchangedDirection: null } });
    const order = ['1 дохиог тооцооноос хаслаа', '1 гүйлгээний ангилал солигдлоо', 'алгасагдлаа', 'шүүлтүүр'].map((part) => msg.indexOf(part));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(msg.endsWith('арилгана уу.')).toBe(true);
  });
});
