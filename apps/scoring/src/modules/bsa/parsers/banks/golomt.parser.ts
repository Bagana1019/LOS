// Голомт банк (Golomt Bank) — хуулгын parser. BSA-FR-2.1, BSA-BR-5, NFR-5.
// TODO(samples): samples/golomt/ хоосон тул формат нь ТААМАГ (verified=false). Хуулгад ЦАГ хэвлэгддэггүй гэж үзсэн (BSA-BR-5: огноо ба
// дүнгээр тулгана), гүйлгээний утганд харилцагчийн нэр орсон байдаг (BSA-BR-5). Зураг/QR (JPG/PNG) хүлээн авна (samples/README.md).
import { Injectable } from '@nestjs/common';
import type { BankProfile } from '../engine/bank-profile';
import { TableStatementParser } from '../engine/table-parser';

export const GOLOMT_PROFILE: BankProfile = {
  bank: 'GOLOMT',
  parserId: 'golomt-table-v1',
  verified: false, // TODO(samples): бодит жишээ файлаар баталгаажтал false байх ёстой
  nameKeywords: ['Голомт банк', 'Голомтбанк', 'Golomt Bank', 'GolomtBank'],
  dateOrder: 'DMY',
  hasTime: false,
  acceptsImages: true,
};

@Injectable()
export class GolomtStatementParser extends TableStatementParser {
  constructor() {
    super(GOLOMT_PROFILE);
  }
}
