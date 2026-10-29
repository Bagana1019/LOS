// Регистр, утас зэрэг хувийн мэдээллийг DB-д шифрлэж хадгалах port (CLAUDE.md §6.5). Гүйцэтгэл: adapters/database-field-cipher.ts (@los/database).
export interface SensitiveFieldCipher { encrypt(plain: string): string; decrypt(cipher: string): string }
export const FIELD_CIPHER = Symbol('FIELD_CIPHER');
