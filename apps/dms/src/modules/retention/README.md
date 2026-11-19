# retention

M10 · `retention_policy` (docs/03) хэрэгжүүлэх sweeper (`RetentionSweeper`, `runExclusive` advisory lock `dms:retention-sweeper`).

* tick бүрт (`DMS_RETENTION_SWEEP_SECONDS`, 0 = унтраах; `DMS_RETENTION_BATCH_SIZE` хүртэл файл):
  1. `dms.document`-д хавсаргасан, `retention_until`-гүй файлд `created_at + retention_years` (`APPLICATION_DOCUMENT` бодлого) бичнэ.
  2. `retention_until <= now`, бодлого `auto_delete=true`, `legal_hold=false`, гэрээний загварт ашиглагдаагүй файлын объектыг storage-оос устгаж `purged_at` тэмдэглэнэ.
* Хавсаргаагүй файл (өөр сервис id-аар нь хадгалж болзошгүй) хэзээ ч устгагдахгүй. Seed-ийн `auto_delete=false` тул анхдагчаар юу ч устгахгүй.
* Лог: зөвхөн тоо (`stamped/purged/failed/skipped`). Объект устгаж чадаагүй бол мөрийг тэмдэглэхгүй, дараагийн tick дахин оролдоно.
