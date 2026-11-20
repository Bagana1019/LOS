# Миграцийн олголт (staging / production)

> **Эх сурвалж:** 2026-11-19-ний «өгөгдөлтэй баазад миграци хэрэглэх» шалгалт — аудитаас өмнөх 31 миграци + ~26 мянган зохиомол мөр дээр аудитын үеийн 10 миграцийг (PR #46–#54) хэрэглэсэн, PostgreSQL 16.16. Доорх «шалгасан» гэсэн зүйл зөвхөн тэр шалгалтад батлагдсан; «шалгаагүй» гэснийг өөрийн орчинд баталгаажуул.
> Энэ баримт **forward-only**: ямар ч миграцид rollback бичигдээгүй. Миграцийн өмнө бүтэн backup/снапшот заавал.

## 1. Хоёр роль

| Роль | Үүрэг | Шаардлага |
| --- | --- | --- |
| `migrator` (нэрийг сонго) | Миграци ажиллуулна, хүснэгтийг **эзэмшинэ** | Зөвхөн олголтын pipeline-д |
| `app` (runtime) | Сервисүүд ажиллах үед | `LOGIN NOSUPERUSER NOCREATEDB`, хүснэгтийг эзэмшигч **БИШ** |

**Яагаад хуваах вэ.**
- Миграцийг runtime роль-оор ажиллуулбал хүлээгдэж буй миграци `42501 must be owner`-оор унаж, Prisma дараагийн олголтыг P3009-ээр хаана (`migrate resolve` хийх хүртэл).
- `audit_log` append-only trigger-ийн хамгаалалт зөвхөн апп роль хүснэгтийг эзэмшдэггүй үед хүчинтэй. Эзэмшигч нь trigger-ийг `DROP` хийж чадах тул хамгаалалт хүчингүй болно (шалгасан).

`scripts/prisma.mjs` нь `<SVC>_DATABASE_URL`, түүнгүй бол `DATABASE_URL`-ийг уншдаг. Pipeline нь миграцийн үед тэдгээрийг **migrator**-ийн холболтоор давж бичнэ.

## 2. Эрх (репод GRANT скрипт байхгүй — pipeline өгнө)

Схемүүд: `origination`, `kyc`, `scoring`, `valuation`, `dms`, `iam` (gateway). Жишээ (өөрийн орчинд шалгаад хэрэглэ):

```sql
GRANT USAGE ON SCHEMA origination, kyc, scoring, valuation, dms, iam TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA origination, kyc, scoring, valuation, dms, iam TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA origination, kyc, scoring, valuation, dms, iam TO app;
-- Миграцийн дараа үүсэх хүснэгт/sequence-д автоматаар:
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA origination, kyc, scoring, valuation, dms, iam GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA origination, kyc, scoring, valuation, dms, iam GRANT USAGE, SELECT ON SEQUENCES TO app;
-- Хоёр дахь давхарга (trigger-ээс гадна): append-only хүснэгтээс өөрчлөх эрхийг авна.
REVOKE UPDATE, DELETE, TRUNCATE ON origination.audit_log, kyc.audit_log, iam.audit_log FROM app;
```

Шалгасан: апп роль энэ эрхээр бүх схемд ердийн INSERT/SELECT/UPDATE хийж чадна; `audit_log` дээр INSERT ажиллана; UPDATE/DELETE/TRUNCATE/`ON CONFLICT DO UPDATE` trigger-ээр, эрхийг нь буцаавал `permission denied`-аар татгалзана; trigger-ийг `DROP`/`DISABLE` хийх, trigger функцийг солих, `session_replication_role` тохируулах боломжгүй.

## 3. Ажиллуулах

```bash
# migrator-ийн холболт (SVC бүрд эсвэл нэг DATABASE_URL-д)
DATABASE_URL=postgresql://migrator:***@host:5432/los pnpm turbo run db:migrate --concurrency=1
```

- **`--concurrency=1` заавал.** Анхдагч `turbo run db:migrate` 6 сервисийг нэг баазад зэрэг ажиллуулдаг. Prisma-ийн баазын түвшний advisory lock бусдыг хүлээлгэх ба барьсан нь 10 секундээс удаан бол бусад нь P1002-оор унана (давтан үзүүлсэн). Эсвэл унасан сервисийг дахин ажиллуул.
- **`lock_timeout`.** Түгжээнд удаан гацахгүйн тулд migrator-д баазын түвшинд тавь: `ALTER ROLE migrator SET lock_timeout = '5s';` (роль-ын GUC бүх клиентэд үйлчилнэ; Prisma-ийн холболтын мөрөнд найдахгүй). Түгжээ олдохгүй бол миграци унаж, дараа нь дахин оролдоно.
- **Цонх.** Ачаалал багатай цагт. `iam.audit_log` (хүсэлт бүрд бичигдэнэ) болон `iam.user` нь нэвтрэлтийн замд байдаг. `CREATE TRIGGER` нь тухайн хүснэгтийн нээлттэй транзакцуудын ард дараалалд орно. Prisma миграцийн файл бүрийг нэг транзакцид ажиллуулдаг тул эхний `ALTER`-ийн ACCESS EXCLUSIVE түгжээ дараагийн индекс үүсгэх хүртэл баригдаж, унших хүсэлтийг ч хаана.
- **Өгөгдлийн урьдчилсан шалгалт шаардлагагүй:** аудитын үеийн миграци байгаа баганад NOT NULL, FK, enum нэмээгүй.

## 4. Миграци тус бүрийн үр дүн (шалгасан)

| Миграци | Үр дүн | Тэмдэглэл |
| --- | --- | --- |
| origination `20261118010000_application_idempotency_key` | OK, том хүснэгтэд түгжээ | Шинэ 2 багана хуучин мөрд NULL → CHECK/UNIQUE давна. 300к мөр ≈ 1.3 с (1М ≈ 4–5 с, экстраполяци) |
| origination `20261118020000_submit_gate_documents_aml` | OK | Шинэ хоосон хүснэгт. `br7.required_steps` шинэчлэл зөвхөн яг хуучин анхдагчид хүрнэ; өөрчилсөн/дахин эрэмбэлсэн/шинэчлэгдсэн утгыг хөндөхгүй |
| origination `20261118034500_disbursement_core_requested_at` | OK | 4 багана (fast default) + жижиг хүснэгтийн индекс |
| origination `20261118040000_payment_invoice_portal_idempotency` | OK, **backfill удаан** | Доорх §5 |
| origination `20261119200000_audit_log_append_only` | OK | Агшин зуур; `CREATE TRIGGER` дараалалд орно |
| kyc `20261119000000_audit_log` | OK | Шинэ хоосон хүснэгт |
| kyc `20261119200000_audit_log_append_only` | OK | Дээрхтэй ижил |
| gateway `20261119100000_user_merchant_scope` | OK | 2 nullable багана + индекс (`iam.user`) |
| gateway `20261119200000_audit_log_append_only` | OK | `iam.audit_log` нь хүсэлт бүрд бичигддэг тул түгжээний дараалал хамгийн мэдрэмтгий |
| dms `20261119120000_file_legal_hold` | OK | `NOT NULL DEFAULT false` нь PG16-д metadata-only |

Хоёр дахь удаа ажиллуулахад юу ч өөрчлөгдөхгүй (idempotent), хоёр шинэ хүснэгтээс бусад хүснэгтийн агуулгын хэш өмнө/дараа ижил.

## 5. `payment_invoice` backfill

Хуучин `note = portal:v1:…` тэмдгийг шилжүүлэх `UPDATE` нь портал тэмдэглэл бүрт ~0.4 мс (regex ~6 удаа), ACCESS EXCLUSIVE түгжээтэй: 90к портал тэмдэглэлд ≈ 35 с. Портал нэхэмжлэх 2026-11-18-аас хойш л үүсэх боломжтой тул хүснэгт одоо бараг хоосон байх магадлалтай — **олголтын өмнө** `SELECT count(*) FROM origination.payment_invoice WHERE note LIKE 'portal:v1:%'` ажиллуул. Хэдэн мянгаас бага бол анхаарах зүйлгүй; арав гаруй мянга бол цонхыг тэр хэмжээнд тааруул.

Энэ миграци `main`-д аль хэдийн нэгдсэн тул **засаагүй**: файлыг өөрчилбөл хэш нь өөрчлөгдөж, аль хэдийн хэрэглэсэн бүх DB-д (хөгжүүлэгчийн, staging) `prisma migrate dev` reset шаардана. Хэрэв production-д энэ нь шинэ бол `regexp_match`-ийг нэг удаа тооцож subselect-д дахин ашиглах засвар (~6× хурдан) боломжтой — гэхдээ хүснэгт том биш бол үнэ цэнэгүй.

## 6. Бусад PR-тай холбоотой тэмдэглэл

- **PR #58 (N4):** dwh-sync эхлэхэд DWH схемийн v3-ыг (`ADD COLUMN IF NOT EXISTS`) өөрөө хэрэглэнэ. DWH-д холбогдох роль DDL хийх эрхтэй (эсвэл эзэмшигч) байх ёстой — **шалгаагүй**.

## 7. Audit seal (audit-tamper-evidence PR-ууд нэгдсэний дараа хамаарна)

`feat/audit-tamper-evidence` нэгдсэний дараа schema бүрд (`iam`, `origination`, `kyc`) хоёр миграци нэмэгдэнэ. Энэ хэсэг тэр хүртэл `main`-д хамаарахгүй.

| Миграци | Үр дүн | Тэмдэглэл |
| --- | --- | --- |
| `20261120000000_audit_seal` | OK (хоосон баазад `migrate deploy`) | `tx_id xid8 NOT NULL DEFAULT '0'` нь metadata-only (хүснэгтийг дахин бичихгүй), дараа нь `SET DEFAULT pg_current_xact_id()`. Trigger + шинэ `audit_seal` хүснэгт. Хуучин мөр `tx_id = 0` болж эхний seal(-үүд)-д орно. `iam.audit_log` нь хүсэлт бүрд бичигддэг тул §3-ын түгжээний дараалал энд ч хамаарна |
| `20261120000001_audit_log_tx_id_index` | OK (хоосон баазад) | `SET LOCAL lock_timeout = '5s'` + энгийн `CREATE INDEX IF NOT EXISTS … ("tx_id", "id" COLLATE "C")`. Үүсгэх хугацаанд тухайн хүснэгтийн бичилт хаагдана (жижиг хүснэгтэд миллисекунд). **`CONCURRENTLY` биш**: Prisma-ийн зэрэгцээ `migrate deploy`-той deadlock болдог (CI-д давтагдсан), тиймээс §3-ын `--concurrency=1` улам чухал |

**Том `audit_log` хүснэгтэд (≈ сая мөр ба түүнээс дээш) бичилтийг хаахгүйн тулд гараар concurrent үүсгэж болно** (заавал биш): `20261120000000_audit_seal`-ийг ажиллуулсны дараа, `20261120000001_…`-ээс ӨМНӨ, нэг холболтоор (өөр `migrate deploy` ажиллаагүй үед) `CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_tx_id_id_idx" ON "<schema>"."audit_log" ("tx_id", "id" COLLATE "C");` хий, дараа нь `migrate deploy` — миграци `IF NOT EXISTS`-ээр энгийнээр өнгөрнө. Бүтэлгүйтвэл `INVALID` индекс үлдэнэ (`DROP INDEX CONCURRENTLY "<schema>"."audit_log_tx_id_id_idx";` → дахин). Шалга: `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;` (хоосон байх ёстой) — `IF NOT EXISTS` нь үлдсэн INVALID индексийн дээгүүр чимээгүй өнгөрдөг. Индексийн collation-ийг Prisma илэрхийлж чадахгүй тул `schema.prisma`-ийн `@@index([txId, id])` drift-д харагдахгүй; индексийг үүсгэгч нь миграцийн SQL.

`20261120000000_audit_seal` нь `SET LOCAL lock_timeout = '5s'`-ээр эхэлнэ: `ALTER TABLE` урт транзакцын ард дараалалд зогсож бүх аудит бичигчийг хаахгүй; түгжээ авч чадахгүй бол миграц бүтэлгүйтнэ (аюулгүй) — ачаалал багатай үед дахин ажиллуул.

**Олголтын шаардлага (pipeline өгнө, код өөрөө өгөхгүй):**

1. `AUDIT_HMAC_KEY`: ≥32 тэмдэгт, placeholder биш, `INTERNAL_AUTH_SECRET`-ээс өөр. Production-д байхгүй бол gateway, origination, kyc **эхлэхгүй**. `AUDIT_HMAC_KEY_ID`-г тогтоо. Rotation-д шинэ түлхүүр + шинэ id, хуучныг `AUDIT_HMAC_PREVIOUS_KEYS=<id>:<key>` (зөвхөн verify) дээр үлдээ.
2. `AUDIT_SEAL_INTERVAL_MS`: бүхэл тоо (анхдагч 60000). Production-д NaN, сөрөг, эсвэл `AUDIT_SEAL_DISABLED=true`-гүй `0` бол сервис эхлэхгүй.
3. App роль: `audit_log`, `audit_seal`-д **SELECT + INSERT л**, эзэмшигч/superuser биш. §2-ын `REVOKE UPDATE, DELETE, TRUNCATE`-д `iam.audit_seal`, `origination.audit_seal`, `kyc.audit_seal`-г нэмж бич.
4. **`AUDIT_SEALED schema seq rows mac` логийг append-only (WORM) хадгалалт руу илгээ.** Үүнгүйгээр эзэмшигч эрхтэй этгээд сүүлийн seal-үүдийг устгаж, мөр засаад sealer-ээр дахин seal хийлгэхийг баазын дотроос илрүүлэх боломжгүй. Pod бүр санасан сүүлийн `(seq, mac)`-ээсээ ухарсныг мэдэж `AUDIT_SEAL_CHAIN_REGRESSED` бүртгээд seal хийхээ зогсооно, гэхдээ бүх pod нэгэн зэрэг restart хийвэл тэр санах ой алдагдана. Тэр үед зөвхөн гаднах anchor л илрүүлнэ.
5. `pnpm --filter <svc> audit:verify --anchor <seq>:<mac>`-г cron-оор ажиллуул. Production-д `--anchor`-гүй бол `UNANCHORED` (exit 3). Seal байх ёстой атал нэг ч seal алга бол `NOT_OK reason=NO_SEALS`.
6. Өөр кластерт restore эсвэл логик репликаци хийвэл транзакцийн тоолуур ухарч `HORIZON_REGRESSED` гарна, seal зогсоно (шинэ гинж эсвэл дахин seal хэрэгтэй). `pg_upgrade` нөлөөлөхгүй. Дэлгэрэнгүй: `docs/DECISIONS.md` «audit seal».
7. Лог дээр alert тавь: `AUDIT_SEAL_CHAIN_REGRESSED`, `AUDIT_SEAL_HORIZON_REGRESSED`, `AUDIT_SEAL_KEY_DOWNGRADE` (pod seal хийхээ зогсоосон — хүн шалгана), `AUDIT_SEAL_FAILED` (tick бүтэлгүйтсэн; давтагдвал шалга).
8. **Seal-ийн саатал нь кластер даяар.** Sealer зөвхөн xid horizon (`pg_snapshot_xmin`)-оос доош мөрийг seal хийдэг бөгөөд энэ нь ижил Postgres дээрх БҮХ баазын бичих транзакцийг тооцдог (origination, scoring, dms-ийн урт ажил ч). Урт бичих транзакц seal-ийг түр хойшлуулна (мөр алдагдахгүй, хоцорно). `audit:verify`-ийн `backlogBelowHorizon` ба `unsealedRows` хэдэн минутаас удаан өсөж байвал `SELECT pid, now() - xact_start AS age, state, left(query, 80) FROM pg_stat_activity WHERE backend_xid IS NOT NULL ORDER BY xact_start;`-ээр хамгийн удаан бичих транзакцийг ол.

## 8. Шалгаагүй

- `pnpm db:seed` (demo seed) — `HEAD` клиент шаардлагатай тул зохиомол SQL-ээр орлуулсан.
- Superuser бус migrator роль (шалгалтад superuser-ээр ажиллуулсан; superuser шаарддаг командыг grep-ээр хайхад олдоогүй).
- Бодит ачаалал дор түгжээний өрсөлдөөн; 1М мөрийн хугацаа (300к-аас экстраполяци); `turbo`-ийн параллель ажиллуулалт (машин ачаалахаас сэргийлж); PostgreSQL 16.16-аас бусад хувилбар.
- Prisma drift: `origination.blacklist`-ийн `blacklist_org_id_register_no_hash_list_type_key` хэсэгчилсэн unique индексийг Prisma «алга» гэж мэдээлдэг (аудитаас өмнөх; шалгалтад нөлөөлөөгүй).
