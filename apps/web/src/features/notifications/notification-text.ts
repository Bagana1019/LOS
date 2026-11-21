import { MNT_SIGN } from '../../lib/format';

// Мэдэгдлийн бичвэрийг сервер `{{amount}} {{currency}}` загвараар үүсгэдэг (currency = ISO код, MNT/USD) тул загварт ₮-г тогтмол бичиж болохгүй.
// Харин харуулахдаа төгрөгийн дүнг `formatMnt`-тэй адил ₮-өөр бичнэ. Хадгалсан бичвэр өөрчлөгдөхгүй.

/** `<дүн> MNT` — өмнө нь үгийн/дугаарын (BZ-2026 …) завсар биш, араас нь үсэг/тоо залгахгүй. */
const MNT_AMOUNT = /(^|[^\w.,-])(\d+(?:,\d{3})*(?:\.\d+)?)\s*MNT(?!\w)/g;

/** "20,000,000 MNT-ийн" → "20,000,000₮-ийн". Бусад валют, дүнгүй "MNT" код хэвээр. */
export const displayNotificationBody = (body: string): string => body.replace(MNT_AMOUNT, `$1$2${MNT_SIGN}`);
