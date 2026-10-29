# DWH

`dwh-sync` энд star schema (fact_application, fact_disbursement, fact_bsa_analysis, dim_customer, dim_product, dim_branch, dim_date) бичнэ. Operational DB руу хэзээ ч бичихгүй.

- `init/01-star-schema.sql` — DDL. Docker compose-д `dwh` сервисийн initdb-д mount хийгдэж, хоосон volume дээр нэг удаа ажиллана.
- Давтан ажиллуулахад аюулгүй (`IF NOT EXISTS`); багана нэмэх өөрчлөлтийг шинэ `02-…sql` файлаар (initdb нь зөвхөн хоосон volume дээр ажилладаг тул байгаа DWH-д гараар/миграцаар хэрэглэнэ).
- Хувийн мэдээлэл (регистр, утас, хаяг, дансны дугаар) DWH-д орохгүй.
