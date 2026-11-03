# ndsh — НДШ цалин (FR-4.1, Модуль 4)

`POST /api/ndsh/salaries` `{registerNo}` → `{fetchedAt, items:[{employer, year, month, salary, contributionPaid}]}` (сүүлийн 24 сар). Эрх: customer:write. Дуудагч: origination `income`.
`integrations/ndsh/`: `NdshClient` + `MockNdshClient` (DEMO) + `RealNdshClient` (fail closed). Унасан → 503 `NDSH_UNAVAILABLE`, бодит холболтгүй → 501. Регистр хадгалагдахгүй, лог-д бичигдэхгүй.
