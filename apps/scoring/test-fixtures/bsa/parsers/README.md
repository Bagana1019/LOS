# SYNTHETIC parser fixtures

Every file in this folder is **synthetic**: made-up names, accounts, register numbers and amounts produced by
`src/modules/bsa/parsers/tests/fixtures-spec.ts`. No real bank statement, person or account is represented.
The per-bank layouts are **assumptions** (TODO(samples): samples/ is empty), not copies of real statements.

- `<bank>/<name>.txt` — text dump (pages split by form feed, lines by newline, cells by TAB)
- `<bank>/<name>.expected.json` — the exact result the generator knows to be true

Regenerate: `UPDATE_FIXTURES=1 npx vitest run src/modules/bsa/parsers/tests/fixtures.test.ts`
