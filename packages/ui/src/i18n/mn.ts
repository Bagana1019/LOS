import mnJson from './mn.json';
import mnMakerChecker from './mn.maker-checker.json';
import mnMerchant from './mn.merchant.json'; // Мерчант POS портал (docs/05 §12): merchant.*, pos.*, error.* — бусад файлтай түлхүүр давхцахгүй
import borrower from './mn.borrower.json';
import payment from './mn.payment.json';
import notification from './mn.notification.json';
import report from './mn.report.json';
// Модуль бүр өөрийн түлхүүрийг тусдаа файлд (mn.<module>.json) хөтөлнө — нэг файлд олон хүн зэрэг засахад зөрчил гарахгүй.
export const mn: Record<string, string> = { ...mnJson, ...mnMakerChecker, ...mnMerchant, ...borrower, ...payment, ...notification, ...report };
