// Controller-ийн pipe-д ашиглах хуваалцсан zod схемүүд (@los/contracts-ийн дээр нимгэн давхарга).
import { BsaIdParam } from '@los/contracts';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

/** `:id` path параметр */
export const idPipe = (): ZodValidationPipe<typeof BsaIdParam> => new ZodValidationPipe(BsaIdParam);

/** Бие нь заавал биш (POST, бие байхгүй ⇒ `{}`): `undefined` / `null` бие хоосон объект болно */
export const orEmpty = <S extends z.ZodTypeAny>(schema: S): z.ZodEffects<z.ZodTypeAny, z.output<S>, unknown> =>
  z.preprocess((v) => v ?? {}, schema) as z.ZodEffects<z.ZodTypeAny, z.output<S>, unknown>;
