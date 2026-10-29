// М банк (M Bank) — хуулгын parser. BSA-FR-2.1, NFR-5.
// TODO(samples): samples/m-bank/ хоосон тул формат нь ТААМАГ (verified=false). Цагтай; дүн "1 234 567.89" (зайгаар мянгатлагдсан)
// хэлбэртэй гэж таамагласан. 'М банк' (кирилл) ба 'M Bank' (латин) нэг түлхүүр болдог (toMatchKey), бүтэн үгээр тулгана.
import { Injectable } from '@nestjs/common';
import type { BankProfile } from '../engine/bank-profile';
import { TableStatementParser } from '../engine/table-parser';

export const MBANK_PROFILE: BankProfile = {
  bank: 'MBANK',
  parserId: 'mbank-table-v1',
  verified: false, // TODO(samples): бодит жишээ файлаар баталгаажтал false байх ёстой
  nameKeywords: ['М банк', 'Мбанк', 'M Bank', 'MBank'],
  dateOrder: 'DMY',
  hasTime: true,
  acceptsImages: true,
  spaceThousands: true,
};

@Injectable()
export class MbankStatementParser extends TableStatementParser {
  constructor() {
    super(MBANK_PROFILE);
  }
}
