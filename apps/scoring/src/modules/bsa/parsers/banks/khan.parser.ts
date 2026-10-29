// Хаан банк (Khan Bank) — хуулгын parser. BSA-FR-2.1, NFR-5.
// TODO(samples): samples/khan/ хоосон тул доорх формат нь ТААМАГ (verified=false). Хаан банк зургаар (JPG/PNG) хуулга хүлээн авдаггүй
// (samples/README.md). Таамагласан хүснэгт: Огноо | Салбар | Эхний үлдэгдэл | Дебит гүйлгээ | Кредит гүйлгээ | Эцсийн үлдэгдэл |
// Гүйлгээний утга | Харьцсан данс — мөр бүрт "Эхний үлдэгдэл" (гүйлгээний өмнөх) багана байдаг гэж үзэж ignore, "Эцсийн үлдэгдэл"-ийг
// гүйлгээний дараах үлдэгдэл (balance) гэж авна.
import { Injectable } from '@nestjs/common';
import type { BankProfile } from '../engine/bank-profile';
import { TableStatementParser } from '../engine/table-parser';

export const KHAN_PROFILE: BankProfile = {
  bank: 'KHAN',
  parserId: 'khan-table-v1',
  verified: false, // TODO(samples): бодит жишээ файлаар баталгаажтал false байх ёстой
  nameKeywords: ['Хаан банк', 'Хаанбанк', 'Khan Bank', 'KhanBank'],
  dateOrder: 'DMY',
  hasTime: true, // BSA-BR-5: Голомт/Хас/Капитрон биш → цагтай
  acceptsImages: false,
  // "Эхний үлдэгдэл" (мөр бүрийн өмнөх үлдэгдэл) нь engine-ийн ignoreAmount синоним тул тусгайлан заахгүй; "Эцсийн үлдэгдэл" = balance
  columnSynonyms: { balance: ['Эцсийн үлдэгдэл'], debit: ['Дебит гүйлгээ'], credit: ['Кредит гүйлгээ'] },
};

@Injectable()
export class KhanStatementParser extends TableStatementParser {
  constructor() {
    super(KHAN_PROFILE);
  }
}
