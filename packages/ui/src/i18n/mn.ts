import mnJson from './mn.json';
import esignMn from './esign.mn.json';
// FR-11.4 цахим гарын үсгийн текстүүд тусдаа файлд (esign.*, verify.*, contractSigning.*) — давхцахгүй
export const mn = { ...mnJson, ...esignMn };
