import { describe, expect, it } from 'vitest';
import { extractContractCandidates, extractInvoiceCandidates } from './transfer-reference';

describe('extractInvoiceCandidates', () => {
  it('энгийн утга: бүтэн дугаар эхэнд (хамгийн урт нь түрүүлж шалгагдана)', () => {
    expect(extractInvoiceCandidates('LOS-APP-00001-1')).toEqual(['LOS-APP-00001-1', 'LOS-APP-00001']);
    expect(extractInvoiceCandidates('LOS-A-1')).toEqual(['LOS-A-1']);
  });

  it('монгол үгтэй, жижиг үсэгтэй утгаас олно', () => {
    expect(extractInvoiceCandidates('Зээлийн төлбөр los-app-00001-a, баярлалаа')).toEqual(['LOS-APP-00001-A', 'LOS-APP-00001']);
  });

  it('араас нь үг залгагдсан бол богино хувилбаруудыг ч өгнө', () => {
    expect(extractInvoiceCandidates('LOS-APP-00001-1-PAYMENT')).toEqual(['LOS-APP-00001-1-PAYMENT', 'LOS-APP-00001-1', 'LOS-APP-00001']);
  });

  it('олон дугаар, давхардлыг арилгана', () => {
    expect(extractInvoiceCandidates('LOS-A-1 болон LOS-B-2 LOS-A-1')).toEqual(['LOS-A-1', 'LOS-B-2']);
  });

  it('таарах зүйл байхгүй', () => {
    expect(extractInvoiceCandidates('сарын төлбөр')).toEqual([]);
    expect(extractInvoiceCandidates('LOS-ONLY')).toEqual([]);
    expect(extractInvoiceCandidates('')).toEqual([]);
  });
});

describe('extractContractCandidates', () => {
  it('цифртэй, ≥ 6 тэмдэгттэй токен', () => {
    expect(extractContractCandidates('Гэрээ B10026021501 төлбөр')).toEqual(['B10026021501']);
  });

  it('жижиг үсгийг том болгоно; цифргүй үг, богино токеныг алгасна', () => {
    expect(extractContractCandidates('b10026021501 PAYMENT 12345')).toEqual(['B10026021501']);
  });

  it('давхардлыг арилгана', () => {
    expect(extractContractCandidates('B10026021501 B10026021501')).toEqual(['B10026021501']);
  });
});
