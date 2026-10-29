// Хас банк (XacBank) — хуулгын parser. BSA-FR-2.1, BSA-BR-5, NFR-5.
// TODO(samples): samples/xac/ хоосон тул формат нь ТААМАГ (verified=false). Хуулгад ЦАГ хэвлэгддэггүй (BSA-BR-5); Зарлага, Орлого
// гэсэн дарааллаар тусдаа багана гэж таамагласан.
import { Injectable } from '@nestjs/common';
import type { BankProfile } from '../engine/bank-profile';
import { TableStatementParser } from '../engine/table-parser';

export const XAC_PROFILE: BankProfile = {
  bank: 'XAC',
  parserId: 'xac-table-v1',
  verified: false, // TODO(samples): бодит жишээ файлаар баталгаажтал false байх ёстой
  nameKeywords: ['Хас банк', 'Хасбанк', 'XacBank', 'Xac Bank'],
  dateOrder: 'DMY',
  hasTime: false,
  acceptsImages: true,
};

@Injectable()
export class XacStatementParser extends TableStatementParser {
  constructor() {
    super(XAC_PROFILE);
  }
}
