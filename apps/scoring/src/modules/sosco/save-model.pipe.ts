// `PUT /api/sosco/models` бие: бүтцийн алдаа (дутуу талбар, буруу төрөл, мужаас гарсан тоо) → 400 VALIDATION_FAILED;
// зөвхөн домэйн дүрмийн зөрчил (жингийн нийлбэр ≠ 1, босго чанд буурахгүй, муруйн хоёр үзүүр) → 422 INVALID_SOSCO_MODEL (UI-д тодорхой).
import { HttpStatus, type PipeTransform } from '@nestjs/common';
import { SaveSoscoModelRequest } from '@los/contracts';
import { scoringError, validationFailed } from '../underwriting/scoring-http';

export class SaveSoscoModelPipe implements PipeTransform<unknown, SaveSoscoModelRequest> {
  transform(value: unknown): SaveSoscoModelRequest {
    const parsed = SaveSoscoModelRequest.safeParse(value);
    if (parsed.success) return parsed.data;
    // zod-ын `.refine` (жин/босго/муруй) нь `custom` код; бусад код бүтцийн алдаа
    if (parsed.error.issues.every((i) => i.code === 'custom')) {
      throw scoringError('INVALID_SOSCO_MODEL', 'Sosco загвар буруу байна: жингийн нийлбэр 1, зэргийн босго чанд буурах (E = 0), муруй хүчинтэй байх ёстой', HttpStatus.UNPROCESSABLE_ENTITY,
        parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), code: i.code })));
    }
    throw validationFailed(parsed.error);
  }
}
