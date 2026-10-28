// Монгол текст/танигчийн нийтлэг хэрэгсэл — @los/ocr-оос экспортлогдоно. Хүснэгт: ./charmap.ts, тайлбар: ./README.md
export { normalizeWhitespace, cyrillicToLatin, foldLatinLookalikesToCyrillic } from './script';
export { toMatchKey } from './match-key';
export { parseMnAmount } from './amount';
export type { ParseAmountOptions } from './amount';
export { parseDateIso, findDates, parseTime } from './date';
export type { DateOrder, ParseDateOptions, FoundDate } from './date';
export { normalizeAccountNo, isValidIban } from './account';
export { parseRegisterNo } from './register';
export type { RegisterNoInfo } from './register';
export { namesMatch } from './names';
export type { NamesMatchOptions, NameMatchResult } from './names';
export { maskForLog } from './mask';
