import PizZip from 'pizzip';

// DEMO гэрээний загвар — жинхэнэ загвар ирэх хүртэл (docs/04 "Хүний оролцоо" №3). Seed болон тест ашиглана.
// Жинхэнэ загварыг LOS-ын загвар засварлагчаар (POST /api/templates) docx болгон оруулна.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const p = (text: string, bold = false) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const cell = (text: string) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;
const row = (cells: string[]) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;

function build(bodyXml: string): Buffer {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

/** ЗЭЭЛИЙН ГЭРЭЭ + ЭТХ хавсралт (DEMO). Зээлдэгчийн нэр, дүн, ЭТХ-ийн хүснэгт орно (M11 AC). */
export function demoLoanContractDocx(): Buffer {
  return build([
    p('ЗЭЭЛИЙН ГЭРЭЭ (DEMO ЗАГВАР)', true),
    p('Гэрээний дугаар: {{contract_no}}    Огноо: {{contract_date}}'),
    p('{{org_name}} (цаашид "Зээлдүүлэгч") болон {{borrower_name}} (регистр: {{borrower_register}}) (цаашид "Зээлдэгч") нар дараах нөхцөлөөр зээлийн гэрээ байгуулав.'),
    p('1. Зээлийн нөхцөл', true),
    p('Бүтээгдэхүүн: {{product_name}}'),
    p('Зээлийн дүн: {{approved_amount}} {{currency}}'),
    p('Хугацаа: {{term_months}} сар; жилийн хүү: {{interest_rate}}%; төлөх арга: {{repayment_type}}'),
    p('Эхний төлбөрийн огноо: {{first_payment_date}}'),
    p('2. Барьцаа', true),
    p('{{collateral_summary}}'),
    p('3. Эргэн төлөлтийн хуваарь (Хавсралт)', true),
    `<w:tbl>${row(['№', 'Огноо', 'Үндсэн төлбөр', 'Хүү', 'Нийт', 'Үлдэгдэл'])}${row(['{{#schedule}}{{no}}', '{{due_date}}', '{{principal}}', '{{interest}}', '{{total}}', '{{balance}}{{/schedule}}'])}</w:tbl>`,
    p('Нийт хүү: {{total_interest}}   Нийт төлөлт: {{total_payment}}'),
    p('Зээлдэгч: {{signer_name}} ______________    Зээлдүүлэгч: {{representative_name}} ______________'),
  ].join(''));
}

/** Албан бичгийн DEMO загвар. */
export function demoOfficialLetterDocx(): Buffer {
  return build([
    p('{{org_name}}', true),
    p('Албан бичиг № {{letter_no}}    {{letter_date}}'),
    p('{{borrower_name}} танд'),
    p('Таны {{contract_no}} дугаартай {{approved_amount}} {{currency}}-ийн зээлийн хүсэлтийг {{branch_name}} салбарын шийдвэрээр ({{decision_no}}) зөвшөөрсөн болохыг мэдэгдье.'),
    p('{{representative_title}} {{representative_name}}'),
  ].join(''));
}
