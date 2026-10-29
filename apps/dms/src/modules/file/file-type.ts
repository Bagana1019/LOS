/** Зөвшөөрөгдсөн файлын төрөл ба "magic bytes" шалгалт: клиентийн зарласан mime-ийг итгэхгүй. */
export interface AllowedType { mime: string; ext: string[]; sniff: (b: Buffer) => boolean }

const startsWith = (b: Buffer, sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
const zip = (b: Buffer) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
const text = (b: Buffer) => !b.subarray(0, 4096).includes(0); // NUL байхгүй

export const ALLOWED_TYPES: readonly AllowedType[] = [
  { mime: 'application/pdf', ext: ['pdf'], sniff: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  { mime: 'image/png', ext: ['png'], sniff: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/jpeg', ext: ['jpg', 'jpeg'], sniff: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: ['docx'], sniff: zip },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: ['xlsx'], sniff: zip },
  { mime: 'text/csv', ext: ['csv'], sniff: text },
  { mime: 'text/plain', ext: ['txt'], sniff: text },
];

export const findAllowedType = (mime: string) => ALLOWED_TYPES.find((t) => t.mime === mime.toLowerCase().split(';')[0]!.trim());
