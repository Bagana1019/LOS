import { describe, expect, it } from 'vitest';
import { searchWords } from './report-search';

// F11-3: хайлтын үгийг үг тус бүрээр (AND) тааруулахын тулд хоосон зайгаар салгана.
describe('searchWords', () => {
  it('хоёр үгтэй бүтэн нэр → хоёр үг (хүснэгтэд харагдсан "Овог Нэр")', () => {
    expect(searchWords('Батсайхан Оюунчимэг')).toEqual(['Батсайхан', 'Оюунчимэг']);
  });

  it('эхэнд/төгсгөлд/дунд олон хоосон зай, tab, мөр шилжилт → нэг л тусгаарлагч', () => {
    expect(searchWords('  Бат   \t Болд\n')).toEqual(['Бат', 'Болд']);
  });

  it('unicode хоосон зай (NBSP, ideographic) ч тусгаарлана — хуулж буулгасан нэр', () => {
    expect(searchWords('Бат Болд　Эрдэнэ')).toEqual(['Бат', 'Болд', 'Эрдэнэ']);
  });

  it('нэг үг (гэрээний дугаар, регистр) өөрчлөгдөхгүй, том/жижиг үсгийг хэвээр үлдээнэ', () => {
    expect(searchWords('B10026LA')).toEqual(['B10026LA']);
    expect(searchWords('уб90000003')).toEqual(['уб90000003']);
  });

  it('хоосон / зөвхөн хоосон зай → үггүй', () => {
    expect(searchWords('')).toEqual([]);
    expect(searchWords(' \t\n ')).toEqual([]);
  });

  it('давхардсан үгийг нэг болгоно (SQL нөхцөл дахин давтагдахгүй)', () => {
    expect(searchWords('Бат бат Бат Болд')).toEqual(['Бат', 'бат', 'Болд']);
  });

  it('тусгай тэмдэгт (%, _, \\, \', эмоджи) үг дотор хэвээр — escape нь SQL давхаргын ажил', () => {
    expect(searchWords("50% O'Brien _ \\ 😀")).toEqual(['50%', "O'Brien", '_', '\\', '😀']);
  });
});
