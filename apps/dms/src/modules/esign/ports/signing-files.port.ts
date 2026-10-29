// esign модулийн DMS файл сантай харилцах нарийн port. Гүйцэтгэл: adapters/prisma-signing-files.ts (dms.file + OBJECT_STORAGE).
// Файл бүр байгууллагад (org) хамаарна: өөр org-ийн файл `FileNotFoundError`.
export interface SigningFileContent { id: string; name: string; mime: string; size: number; sha256: string; bytes: Buffer }
export interface SaveSigningFileInput { orgId: string; name: string; mime: string; bytes: Buffer; uploadedBy: string | null }
export interface SigningFiles {
  /** Файл байхгүй (эсвэл өөр org-ийнх) бол `FileNotFoundError`; агуулга зөрвөл `FileIntegrityError` */
  read(orgId: string, fileId: string): Promise<SigningFileContent>;
  /** Агуулгыг sha256-тай хамт хадгалж, шинэ file id буцаана */
  save(input: SaveSigningFileInput): Promise<{ id: string; sha256: string; size: number }>;
}
export class FileNotFoundError extends Error { constructor(readonly fileId: string) { super(`file not found: ${fileId}`); this.name = 'FileNotFoundError'; } }
export type FileIntegrityReason = 'CONTENT_MISSING' | 'SIZE_MISMATCH' | 'CHECKSUM_MISMATCH';
/** DB-ийн мөр ба storage дахь агуулга зөрсөн (устсан, өөрчлөгдсөн) — агуулгыг ХЭЗЭЭ Ч буцаахгүй */
export class FileIntegrityError extends Error {
  constructor(readonly fileId: string, readonly reason: FileIntegrityReason) { super(`file ${fileId} failed integrity check: ${reason}`); this.name = 'FileIntegrityError'; }
}
export const SIGNING_FILES = Symbol('SIGNING_FILES');
