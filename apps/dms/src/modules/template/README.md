# template

Модуль 11 · FR-11.1/11.2: гэрээ, ЭТХ, албан бичгийн **docx загвар** (`dms.contract_template`) ба загвараас PDF.

- `POST /api/templates` (multipart `file`=.docx, `type`, `name`, `productId?`; `settings:manage`): placeholder-уудыг уншиж хадгална. Ижил (бүтээгдэхүүн, төрөл)-д шинэ хувилбар `version+1` идэвхтэй болж өмнөх нь идэвхгүй болно; `PATCH :id/active` нь rollback.
- `GET /api/templates/placeholders` — placeholder каталог (`@los/contracts` `PLACEHOLDER_CATALOG`); `GET /api/templates?type&productId&activeOnly` — `unknownPlaceholders` (каталогт байхгүй түлхүүр) харуулна.
- `POST /api/templates/render` (origination л дууддаг; gateway-ээр гаргахгүй): `{type, productId?, templateId?, data, fileBaseName}` → docxtemplater (`{{key}}`, давталт `{{#schedule}}…{{/schedule}}`) → PDF → `docxFileId`, `pdfFileId` (dms файл). Бүтээгдэхүүний идэвхтэй загвар, байхгүй бол нийтлэг (`productId=null`); байхгүй бол 422 `TEMPLATE_NOT_CONFIGURED`.
- `POST /api/templates/demo` — DEMO загвар суулгана (идэмпотент). **Жинхэнэ загвар ирээгүй** (docs/04 "Хүний оролцоо" №3).
- docx → PDF: анхдагч `PdfLibConverter` (DEMO: догол мөр + хүснэгт, зураг/форматгүй, DejaVu Sans кирилл). `DOCX_PDF_ENGINE=libreoffice` (+ `SOFFICE_BIN`) бол LibreOffice-оор бодит формат.
