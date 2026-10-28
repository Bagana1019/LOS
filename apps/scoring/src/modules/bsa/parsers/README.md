# bsa/parsers — банк бүрийн хуулгын parser
Interface: `StatementParser { bank: BankCode; canParse(file): boolean; parse(file): ParsedStatement }`.
Файлууд: khan.parser.ts, golomt.parser.ts, tdb.parser.ts, xac.parser.ts, capitron.parser.ts, state.parser.ts, mbank.parser.ts.
Тест: `samples/<bank>/` дахь файлаар; байхгүй бол TODO + skip.
Verifier: үлдэгдлийн гинж, IBAN, нэр, QR (docs/02 BSA-FR-2.2/2.3).
