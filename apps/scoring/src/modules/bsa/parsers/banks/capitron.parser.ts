// Капитрон банк (Capitron Bank) — хуулгын parser. BSA-FR-2.1, BSA-BR-5, NFR-5.
// TODO(samples): samples/capitron/ хоосон тул формат нь ТААМАГ (verified=false). Хуулгад ЦАГ хэвлэгддэггүй (BSA-BR-5); нэг "Дүн"
// баганад орлого эерэг, зарлага сөрөг тэмдэгтэй гэж таамагласан.
import { Injectable } from '@nestjs/common';
import type { BankProfile } from '../engine/bank-profile';
import { TableStatementParser } from '../engine/table-parser';

export const CAPITRON_PROFILE: BankProfile = {
  bank: 'CAPITRON',
  parserId: 'capitron-table-v1',
  verified: false, // TODO(samples): бодит жишээ файлаар баталгаажтал false байх ёстой
  nameKeywords: ['Капитрон банк', 'Капитронбанк', 'Capitron Bank', 'CapitronBank'],
  dateOrder: 'DMY',
  hasTime: false,
  acceptsImages: true,
};

@Injectable()
export class CapitronStatementParser extends TableStatementParser {
  constructor() {
    super(CAPITRON_PROFILE);
  }
}
