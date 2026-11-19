# retention

M10 · `retention_policy` (docs/03) хэрэгжүүлэх sweeper (`RetentionSweeper`, `runExclusive` advisory lock `dms:retention-sweeper`).

* tick бүрт (`DMS_RETENTION_SWEEP_SECONDS`, 0 = унтраах; `DMS_RETENTION_BATCH_SIZE` хүртэл файл):
  1. `dms.document`-д хавсаргасан, `retention_until`-гүй файлд `created_at + retention_years` (`APPLICATION_DOCUMENT` бодлого) бичнэ.
  2. `retention_until <= now`, бодлого `auto_delete=true`, `legal_hold=false`, `FILE_REFERENCES`-ийн (`retention.service.ts`) эзнээс (`document`) бусад ямар ч хүснэгтэд лавлагаагүй файлыг: түгжиж дахин шалгана → `purged_at` → storage-оос устгана (нэг транзакц).
* **Шинэ `dms.file`-г заасан багана нэмбэл `FILE_REFERENCES`-д бүртгэ** — e2e тест DB-ийн FK болон `*file_id` баганыг тулгаж унана.
* Хавсаргаагүй файл (өөр сервис id-аар нь хадгалж болзошгүй) хэзээ ч устгагдахгүй. Seed-ийн `auto_delete=false` тул анхдагчаар юу ч устгахгүй.
* Лог: зөвхөн тоо (`stamped/purged/failed/skipped`). Объект устгаж чадаагүй бол мөрийг тэмдэглэхгүй, дараагийн tick дахин оролдоно.
