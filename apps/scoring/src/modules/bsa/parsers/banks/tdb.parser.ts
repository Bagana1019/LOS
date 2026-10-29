// Худалдаа хөгжлийн банк (ХХБ / TDB) — хуулгын parser. BSA-FR-2.1, NFR-5.
// TODO(samples): samples/tdb/ хоосон тул формат нь ТААМАГ (verified=false). Цагтай; Орлого / Зарлага тусдаа багана гэж таамагласан.
// 'TDB', 'ХХБ' зэрэг богино түлхүүр үгийг зөвхөн толгой хэсэгт БҮТЭН ҮГЭЭР тулгана (гүйлгээний утгын 'TDB'-д хууртахгүй).
import { Injectable } from '@nestjs/common';
import type { BankProfile } from '../engine/bank-profile';
import { TableStatementParser } from '../engine/table-parser';

export const TDB_PROFILE: BankProfile = {
  bank: 'TDB',
  parserId: 'tdb-table-v1',
  verified: false, // TODO(samples): бодит жишээ файлаар баталгаажтал false байх ёстой
  nameKeywords: ['Худалдаа хөгжлийн банк', 'ХХБ', 'TDB', 'TDBM', 'Trade and Development Bank'],
  dateOrder: 'DMY',
  hasTime: true,
  acceptsImages: true,
};

@Injectable()
export class TdbStatementParser extends TableStatementParser {
  constructor() {
    super(TDB_PROFILE);
  }
}
