import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import { isSignedScanFile, isSignedScanTypeError, SIGNED_SCAN_ACCEPT } from './signed-scan';

// F4-13: гарын үсэгтэй гэрээний скан зөвхөн PDF / PNG / JPG. Файлыг DMS-д байршуулахаас ӨМНӨ шалгана.
describe('SIGNED_SCAN_ACCEPT', () => {
  it('lists only pdf, png, jpg and jpeg', () => {
    expect(SIGNED_SCAN_ACCEPT).toBe('.pdf,.png,.jpg,.jpeg');
  });
});

describe('isSignedScanFile', () => {
  it.each([
    ['scan.pdf', 'application/pdf'],
    ['scan.PDF', 'application/pdf'],
    ['photo.png', 'image/png'],
    ['photo.PNG', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['Гэрээ 2026.JPG', 'image/jpeg'],
    ['scan.pdf', ''], // зарим хөтөч MIME-ийг мэдэхгүй — сервер агуулгаар эцэслэн шалгана
  ])('accepts %s (%s)', (name, type) => {
    expect(isSignedScanFile({ name, type })).toBe(true);
  });

  it.each([
    ['notes.txt', 'text/plain'],
    ['contract.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['data.csv', 'text/csv'],
    ['scan', ''], // өргөтгөлгүй
    ['scan.pdf.txt', 'text/plain'], // сүүлийн өргөтгөл л тооцогдоно
    ['scan.pdf.exe', 'application/octet-stream'],
    ['anim.gif', 'image/gif'],
    ['scan.', ''],
  ])('rejects %s (%s) by extension', (name, type) => {
    expect(isSignedScanFile({ name, type })).toBe(false);
  });

  it('rejects an allowed extension whose declared MIME is not an allowed one', () => {
    expect(isSignedScanFile({ name: 'notes.pdf', type: 'text/plain' })).toBe(false);
    expect(isSignedScanFile({ name: 'pic.png', type: 'image/gif' })).toBe(false);
  });
});

describe('isSignedScanTypeError', () => {
  it('recognises the server code on an ApiError', () => {
    expect(isSignedScanTypeError(new ApiError(415, 'SIGNED_SCAN_TYPE_NOT_ALLOWED', 'x'))).toBe(true);
  });
  it('ignores other errors', () => {
    expect(isSignedScanTypeError(new ApiError(415, 'OTHER', 'x'))).toBe(false);
    expect(isSignedScanTypeError(new ApiError(500, null, 'x'))).toBe(false);
    expect(isSignedScanTypeError(new Error('x'))).toBe(false);
    expect(isSignedScanTypeError(null)).toBe(false);
  });
});
