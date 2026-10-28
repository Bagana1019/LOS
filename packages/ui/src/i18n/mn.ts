import mnJson from './mn.json';
import mnCustomer from './mn.customer.json';
// Модуль бүр өөрийн `mn.<module>.json`-той (зэрэгцээ салбарын мерж зөрчилгүй байлгахын тулд); энд нэгтгэнэ.
export const mn = { ...mnJson, ...mnCustomer };
