// Банкны бодлогын анхдагч (parser.policy байхгүй үед). НЭГ газар. BSA-FR-2.2
import type { BankPolicy } from './statement.types';

export const DEFAULT_BANK_POLICY: Readonly<BankPolicy> = Object.freeze({ acceptsImages: true, printsNonStandardIban: false });
