// Blacklist модулийн DI token ба жижиг port-ууд. Clock/IdGenerator нь тестэд тогтмол утга өгөхөд хэрэгтэй.
export const PII_CIPHER = Symbol('BLACKLIST_PII_CIPHER');
export const BLACKLIST_CLOCK = Symbol('BLACKLIST_CLOCK');
export const BLACKLIST_IDS = Symbol('BLACKLIST_IDS');

/**
 * Регистрийг reversible шифрлэх (CLAUDE.md §6.5). kyc-ийн aml.ports.ts-тэй адил хэлбэр (сервис дундын import хориотой тул давтав).
 * Default нь @los/database encryptedField/decryptedField — M00 хүртэл `TODO(M00)` шиддэг тул тестэд хуурамч cipher өгнө.
 */
export interface PiiCipher { encrypt(plain: string): string; decrypt(cipher: string): string }
export interface Clock { now(): Date }
export interface IdGenerator { uuid(): string }
