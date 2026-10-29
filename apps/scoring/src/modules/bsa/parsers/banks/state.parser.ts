// Төрийн банк (State Bank of Mongolia) — хуулгын parser. BSA-FR-2.1, NFR-5.
// TODO(samples): samples/state/ хоосон тул формат нь ТААМАГ (verified=false). Цагтай; "Дүн" + "Дт/Кт" төрлийн багана гэж таамагласан.
// 'State Bank' нь гадаадын банкны нэртэй давхцдаг тул (State Bank of India...) тэдгээрийг rejectKeywords-оор хаана.
import { Injectable } from '@nestjs/common';
import type { BankProfile } from '../engine/bank-profile';
import { TableStatementParser } from '../engine/table-parser';

export const STATE_PROFILE: BankProfile = {
  bank: 'STATE',
  parserId: 'state-table-v1',
  verified: false, // TODO(samples): бодит жишээ файлаар баталгаажтал false байх ёстой
  nameKeywords: ['Төрийн банк', 'State Bank of Mongolia', 'State Bank'],
  rejectKeywords: ['State Bank of India', 'State Bank of Pakistan', 'State Bank of Vietnam'],
  dateOrder: 'DMY',
  hasTime: true,
  acceptsImages: true,
};

@Injectable()
export class StateStatementParser extends TableStatementParser {
  constructor() {
    super(STATE_PROFILE);
  }
}
