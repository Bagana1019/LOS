# payment — ЭТХ-ийн төлбөр цуглуулах (QPay · SocialPay · банкны шилжүүлэг)

LOS нь Core биш (зээлийн дансны бүртгэл Core-д). Энэ модуль нь ЭТХ-ийн мөрүүдийн эргэн төлөлтийг цуглуулж (`payment_invoice`),
орж ирсэн төлбөрийг (`payment`) ЭТХ-ийн мөрүүдэд хуваарилна (`payment_allocation`, `@los/calc` `allocatePayment`).
Шаардлага: FR-12.4, NFR-2, NFR-4/5, CLAUDE.md §3.2.7.

## Төлбөр бүртгэх цорын ганц зам
`PaymentService.recordPayment()` — callback, poll (GET invoice / maintenance), банкны тулгалт бүгд эндээр дамжина:
нэг `$transaction`-д application мөрийг `FOR UPDATE`-оор түгжиж, `(provider, providerPaymentId)`-ээр idempotent бүртгэж,
одоогийн (stale биш) ЭТХ-д хуваарилж, invoice-ийг PAID болгож, `PaymentReceived` event-ийг outbox-д бичнэ.

## Тохиргоо
| Нэр | Утга |
| --- | --- |
| `INTEGRATION_MODE`, `INTEGRATION_MODE_QPAY` / `_SOCIALPAY` / `_BANK_TRANSFER` | `mock` (анхдагч) \| `real` |
| `QPAY_USERNAME`, `QPAY_PASSWORD`, `QPAY_INVOICE_CODE`, `QPAY_CALLBACK_BASE_URL` | QPay real (заавал). `QPAY_CALLBACK_BASE_URL` нь gateway-ийн `/api` угтвартай нийтийн суурь URL |
| `QPAY_BASE_URL` | анхдагч `https://merchant-sandbox.qpay.mn/v2` |
| `SOCIALPAY_*`, `BANK_GATEWAY_*` | skeleton — бодит холболт хараахан хэрэгжээгүй (NotImplemented) |
| `PAYMENT_MAINTENANCE=off` | expire / poll / тулгалтын timer-ийг унтраана |
| `PAYMENT_MAINTENANCE_INTERVAL_SEC` (60), `PAYMENT_RECONCILE_INTERVAL_MIN` (10), `PAYMENT_EXPIRED_RECHECK_INTERVAL_MIN` (10) | timer-ийн интервал |
| setting `payment.invoice_ttl_minutes` (60), `payment.min_amount` (1000), `payment.collection_account` | байгууллага бүрийн тохиргоо |

`payment.collection_account` = `{ bankCode, accountNo, accountName }` — банкны шилжүүлгийн заавар ба тулгалтын данс. Mock горимд хоосон бол mock данс.

## Гүйлгээний утга
`senderInvoiceNo` = `LOS-<appNo>-<base36 seq>`. Банкны тулгалт гүйлгээний утгаас үүнийг (эсвэл гэрээний дугаарыг) олно.

## Invoice-ийн хугацаа дуусалт ба алдагдсан төлбөр (мөнгө алдахгүй зарчим)
- Хугацаа дууссан PENDING invoice-ийг провайдераас **амжилттай шалгасны дараа** л EXPIRED болгоно. Шалгалт унасан бол PENDING хэвээр үлдэж дараагийн
  GET/sweep дээр дахин шалгагдана; зөвхөн `expiresAt + 24 цаг` (`UNVERIFIED_EXPIRY_GRACE_MS`)-аас хойш хүчээр EXPIRED болно.
- EXPIRED болгоход провайдерт цуцлалт амжилтгүй бол (жишээ нь "төлөгдсөн" гэж татгалзсан) дахин шалгаж төлбөрийг бүртгэнэ.
- `PaymentMaintenance.recheckExpired()` — сүүлийн 48 цагт (`EXPIRED_RECHECK_WINDOW_MS`) хугацаа дууссан QPay/SocialPay invoice-ийг дахин шалгаж хожуу төлбөрийг нөхнө.
- Фоны timer-ийн алдаа (DB унасан гэх мэт) unhandled rejection болохгүй: метод бүр алдаагаа логлоно, timer callback нэмж `.catch`-тэй.

## Банкны тулгалт: нэг гүйлгээний алдаа бусдыг хаахгүй
Гүйлгээ бүр өөрийн try/catch-тэй. Алдаатай гүйлгээ `BankTransferEntry.status = FAILED` болж, хариуны `errors` тоологдоно; дараагийн тулгалт FAILED мөрийг
дахин оролдоно. 2 оронд бөөрөнхийлөхөд 0 болох дүн (жишээ нь 0.004) алгасагдана.
