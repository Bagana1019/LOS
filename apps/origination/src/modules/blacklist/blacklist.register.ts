// F8-1: хар жагсаалтын регистрийн шалгалт. Бичих бүх зам (POST, PATCH, импорт) `GET /blacklist/check`-тэй ижил `customerTypeOfRegister`
// (@los/contracts)-ийг хэрэглэнэ: хадгалагдсан идэвхтэй бүртгэл бүр `check`-ээр олдож чадна (өмнө нь "UB…", 9 орон, "УБ1234" нь идэвхтэй
// хадгалагдаад хэзээ ч таардаггүй байсан).
// Латин үсгийг кирилл болгож ХӨРВҮҮЛЭХГҮЙ, няцаана: hash-ийн look-alike нийлүүлэлт хэсэгчилсэн (Б-д латин ихэр үсэг байхгүй тул "UB…" нь
// "УБ…" болж чадахгүй), харин `check`/харилцагчийн маягт латиныг няцаадаг. Тусгаарлагч (зай, зураас …) өмнөх шигээ чимээгүй хасагдана.
import { BadRequestException } from '@nestjs/common';
import { customerTypeOfRegister, type AmlSubjectType } from '@los/contracts';
import { stripRegisterSeparators } from './blacklist.schemas';

export const INVALID_REGISTER_NO = 'INVALID_REGISTER_NO';
export const REGISTER_TYPE_MISMATCH = 'REGISTER_TYPE_MISMATCH';
/** `GET /blacklist/check` ба бичих замын нэг мессеж (тогтмол: регистрийг эхo хийхгүй). */
export const INVALID_REGISTER_MESSAGE = 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)';
const LATIN_REGISTER_MESSAGE = 'Регистрийн дугаарт латин үсэг байна: үсгийг кириллээр бичнэ үү (иргэн УБ12345678, байгууллага 7 орон)';
const LATIN = /\p{Script=Latin}/u;
const TYPE_LABEL: Record<AmlSubjectType, string> = { INDIVIDUAL: 'Иргэн', LEGAL_ENTITY: 'Байгууллага' };
const SHAPE_LABEL: Record<AmlSubjectType, string> = { INDIVIDUAL: 'иргэний (УБ12345678)', LEGAL_ENTITY: 'байгууллагын (7 орон)' };

/** 400 `{ code, message }` (`check`-тэй ижил хэлбэр). `field` нь импортын мөрийн алдаанд талбарын нэрийг өгнө. */
export class InvalidRegisterError extends BadRequestException {
  constructor(readonly code: typeof INVALID_REGISTER_NO | typeof REGISTER_TYPE_MISMATCH, message: string, readonly field: 'registerNo' | 'customerType') {
    super({ code, message });
  }
}

/** Регистрийн хэлбэр танигдаж, сонгосон төрөлтэй таарах ёстой; үгүй бол InvalidRegisterError. */
export function assertRegisterMatchesType(registerNo: string, customerType: AmlSubjectType): void {
  const compact = stripRegisterSeparators(registerNo);
  const detected = customerTypeOfRegister(compact);
  if (!detected) throw new InvalidRegisterError(INVALID_REGISTER_NO, LATIN.test(compact) ? LATIN_REGISTER_MESSAGE : INVALID_REGISTER_MESSAGE, 'registerNo');
  if (detected !== customerType) {
    throw new InvalidRegisterError(REGISTER_TYPE_MISMATCH, `Регистр ${SHAPE_LABEL[detected]} хэлбэртэй, харин сонгосон төрөл "${TYPE_LABEL[customerType]}" байна — төрлөө зөв сонгоно уу`, 'customerType');
  }
}
