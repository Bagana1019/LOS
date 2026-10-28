import mnJson from './mn.json';
import mnMakerChecker from './mn.maker-checker.json';
import borrower from './mn.borrower.json';
import payment from './mn.payment.json';
import notification from './mn.notification.json';
import report from './mn.report.json';
// Модуль бүр өөрийн түлхүүрийг тусдаа файлд (mn.<module>.json) хөтөлнө — нэг файлд олон хүн зэрэг засахаас сэргийлнэ.
export const mn: Record<string, string> = { ...mnJson, ...mnMakerChecker, ...borrower, ...payment, ...notification, ...report };
