// BSA import pipeline-ийн техникийн анхдагч утгууд — НЭГ газар. Бизнесийн босго (ББӨ, хугацаа, зөвшөөрөх зөрүү, retention жил, upload хязгаар)
// энд БАЙХГҮЙ: тэдгээр BsaSettings-ээс ирнэ. Энд зөвхөн хамгаалалтын хязгаар, chunk хэмжээ, хугацаа.
import { EnvConfigError, envInteger, type EnvLike } from '../common/env';

export const BSA_IMPORT_OPTIONS = Symbol('BSA_IMPORT_OPTIONS');
export const BSA_CLOCK = Symbol('BSA_CLOCK');

/** Тестэд тогтмол цаг шахах. Анхдагч: системийн цаг */
export interface Clock {
  now(): Date;
}
export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

export interface ImportOptions {
  /** Нэг файлаас уншсан гүйлгээний дээд тоо (санах ой/DB хамгаалалт). Хэтэрвэл TOO_MANY_ROWS (дахин оролдохгүй) */
  maxRowsPerFile: number;
  /** Файлаас текст гаргах (PDF/OCR) дээд хугацаа, ms. Хэтэрвэл IMPORT_TIMEOUT */
  extractTimeoutMs: number;
  /** Нэг импорт ажлын нийт дээд хугацаа, ms (шатлал бүрийн хооронд шалгана). Хэтэрвэл IMPORT_TIMEOUT */
  jobTimeoutMs: number;
  /** bulkInsert + явцын шинэчлэлтийн нэг багцын мөрийн тоо (NFR-1: явц мөрөөр) */
  insertChunkRows: number;
  /** Retention: нэг гүйлтэд устгах шинжилгээний дээд тоо */
  retentionBatchSize: number;
  /** Retention: тогтмол хугацааны таймер (ms). 0 = таймергүй (гаднаас purgeExpired дуудна) */
  retentionIntervalMs: number;
  /** Retention-ийн хамгийн бага нас (жил) — олох шүүлтийн тасалбар. BsaSettings.retentionYears-ийн схемийн доод хязгаар (1) */
  retentionDiscoveryMinYears: number;
}

export const IMPORT_DEFAULTS: Readonly<ImportOptions> = Object.freeze({
  maxRowsPerFile: 50_000,
  extractTimeoutMs: 180_000,
  jobTimeoutMs: 300_000,
  insertChunkRows: 500,
  retentionBatchSize: 100,
  retentionIntervalMs: 0,
  retentionDiscoveryMinYears: 1,
});

/**
 * Env: BSA_IMPORT_MAX_ROWS, BSA_IMPORT_EXTRACT_TIMEOUT_MS, BSA_IMPORT_JOB_TIMEOUT_MS, BSA_IMPORT_CHUNK_ROWS,
 * BSA_RETENTION_BATCH, BSA_RETENTION_INTERVAL_MS (0 = унтраалттай). Буруу утга EnvConfigError.
 */
export function resolveImportOptions(env: EnvLike = process.env, overrides: Partial<ImportOptions> = {}): ImportOptions {
  const options: ImportOptions = {
    ...IMPORT_DEFAULTS,
    maxRowsPerFile: envInteger(env, 'BSA_IMPORT_MAX_ROWS', { min: 1 }) ?? IMPORT_DEFAULTS.maxRowsPerFile,
    extractTimeoutMs: envInteger(env, 'BSA_IMPORT_EXTRACT_TIMEOUT_MS', { min: 1 }) ?? IMPORT_DEFAULTS.extractTimeoutMs,
    jobTimeoutMs: envInteger(env, 'BSA_IMPORT_JOB_TIMEOUT_MS', { min: 1 }) ?? IMPORT_DEFAULTS.jobTimeoutMs,
    insertChunkRows: envInteger(env, 'BSA_IMPORT_CHUNK_ROWS', { min: 1, max: 5_000 }) ?? IMPORT_DEFAULTS.insertChunkRows,
    retentionBatchSize: envInteger(env, 'BSA_RETENTION_BATCH', { min: 1, max: 10_000 }) ?? IMPORT_DEFAULTS.retentionBatchSize,
    retentionIntervalMs: envInteger(env, 'BSA_RETENTION_INTERVAL_MS', { min: 0 }) ?? IMPORT_DEFAULTS.retentionIntervalMs,
    ...overrides,
  };
  for (const key of ['maxRowsPerFile', 'extractTimeoutMs', 'jobTimeoutMs', 'insertChunkRows', 'retentionBatchSize'] as const) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new EnvConfigError(key, 'must be an integer >= 1');
  }
  if (!Number.isInteger(options.retentionIntervalMs) || options.retentionIntervalMs < 0) {
    throw new EnvConfigError('retentionIntervalMs', 'must be an integer >= 0');
  }
  return Object.freeze(options);
}
