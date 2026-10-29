# SYNTHETIC text-extraction fixtures

Every file in this folder is **synthetic**: made-up headers, descriptions, dates and amounts produced by `make_fixtures.py`.
No real bank statement, person, account or register number is represented, and the table layouts are **not** copies of any bank's
format (TODO(samples): `samples/` is empty, so real bank files have never been run through these extractors).

| File | What it is | Used by |
| --- | --- | --- |
| `statement-table.png` | 5-column statement table image (Cyrillic headers, DejaVu Sans, 300 dpi) | `ocr.integration.test.ts` (real Tesseract `mon+eng`; skipped when `tesseract`/language data is missing) |
| `cyrillic-statement.pdf` | One-page PDF with an embedded TrueType font and Mongolian letters (Ө, Ү) | `pdf-text.extractor.test.ts` |
| `encrypted-user-password.pdf` | RC4-128, **user password required** (`userpw`) | `PDF_ENCRYPTED` tests |
| `encrypted-owner-only.pdf` | RC4-128, empty user password (owner password only) — opens without a password | `meta.pdf.isEncrypted` tests |

Regenerate (needs Pillow, reportlab, pypdf, DejaVu fonts): `cd apps/scoring/test-fixtures/bsa/text-extraction && python3 -I make_fixtures.py`.
The encrypted PDFs contain random salts, so regenerating changes their bytes (the tests assert behaviour, not hashes).

Other PDFs used by the tests (statement-like tables, rotated pages, signature fields, metadata) are built in-test with `pdf-lib`
(`src/modules/bsa/parsers/text-extraction/testing/pdf-builder.ts`), CSV/TXT inputs are inline strings or hand-encoded bytes.
