import type { BlacklistSeverity } from '@los/contracts';
import { hasMessage, t } from '../../lib/i18n';

/** DEMO шалтгаан/жагсаалтын код (Q-101; docs/05-compliance-aml.md §11). Бодит кодыг эзэмшигч баталгаажуулна; импортоор өөр код орж болно. */
export const REASON_CODES = ['OVERDUE_90', 'FRAUD_CASE', 'COURT_ORDER', 'SANCTIONS', 'FALSE_DOCUMENTS', 'WRITTEN_OFF', 'SUSPICION', 'WATCH', 'OTHER'] as const;
export const LIST_TYPES = ['DELINQUENT', 'FRAUD', 'LEGAL', 'WATCH'] as const;

/** Код → монгол нэр; үл мэдэгдэх (импортын) код өөрөө харагдана. */
export const reasonLabel = (code: string): string => (hasMessage(`blacklist.reason.${code}`) ? t(`blacklist.reason.${code}`) : code);
export const listTypeLabel = (code: string): string => (hasMessage(`blacklist.listType.${code}`) ? t(`blacklist.listType.${code}`) : code);
export const severityColor = (s: BlacklistSeverity): string => (s === 'BLACK' ? 'default' : 'gold');
/** Хар = харанхуй фон, саарал = саарал. antd preset өнгө биш тул өөрсдөө. */
export const severityStyle = (s: BlacklistSeverity) => (s === 'BLACK' ? { background: '#262626', color: '#fff', borderColor: '#262626' } : { background: '#d9d9d9', color: '#262626', borderColor: '#bfbfbf' });

/** Маягтын регистр: том үсэг, зайгүй. Бүрэн шалгалтыг сервер хийнэ (blind index-ийн нормчлол). */
export const cleanRegisterInput = (raw: string): string => raw.replace(/\s+/g, '').toUpperCase();
/** Регистрийн ихэнх тэмдэгтийг нууж харуулна: УБ12345678 → УБ••••5678 (цээж мэдээллийг дэлгэцэд бүрэн тавихгүй). */
export function maskRegister(r: string): string {
  if (r.length <= 6) return r;
  return `${r.slice(0, 2)}${'•'.repeat(r.length - 6)}${r.slice(-4)}`;
}

const AUDIT_ACTIONS = ['CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE'];
export const auditActionLabel = (a: string): string => (AUDIT_ACTIONS.includes(a) ? t(`blacklist.audit.${a}`) : a);
