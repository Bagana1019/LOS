import { z } from 'zod';

/**
 * `origination.setting`-ийн түлхүүрийн бүртгэл (docs/01 §8 BR-1…BR-13, docs/02 BSA-BR). Утга DB-д (`setting.value_json`) —
 * код hardcode хийхгүй (CLAUDE.md §6.2). Энд зөвхөн түлхүүр, схем, seed-ийн анхдагч утга (DEMO таамаг — docs/DECISIONS.md).
 * Харьцааг бутархай хэлбэрээр хадгална: 0.55 = 55% (docs/03).
 */
const def = <T extends z.ZodTypeAny>(schema: T, value: z.infer<T>, description: string) => ({ schema, default: value as unknown, description });

export const SETTING_REGISTRY = {
  // ── Бизнес дүрэм (docs/01 §8) ──
  'br1.dti_max': def(z.number().min(0).max(1), 0.55, 'BR-1 · ӨОХ дээд (A арга, BSA DTI мөн ижил)'),
  'br2.dscr_min': def(z.number().positive(), 1.25, 'BR-2 · ӨТЧХ доод (B, C арга)'),
  'br3.ltv_max': def(z.number().min(0).max(1), 0.7, 'BR-3 · LTV дээд'),
  'br4.method_weight_threshold': def(z.number().min(0).max(1), 0.7, 'BR-4 · автомат аргын сонголтын жингийн босго'),
  'br7.required_steps': def(z.array(z.string()), ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score'], 'BR-7 · илгээхэд заавал бүрдэх алхмууд'),
  'br9.blacklist_mode': def(z.enum(['WARN_ONLY']), 'WARN_ONLY', 'BR-9 · хар жагсаалт — зөвхөн анхааруулга'),
  'br10.disburse_not_exceed_approved': def(z.boolean(), true, 'BR-10 · олгох дүн ≤ батлагдсан дүн'),
  'br12.system_officer_label': def(z.string(), 'Систем', 'BR-12 · системээс үүссэн хүсэлтийн ЗЭЗ-ийн нэр'),
  // ── Ерөнхий ──
  'inquiry.stale_days': def(z.number().int().positive(), 30, 'FR-3.5 · лавлагаа хуучрах хоног'),
  'draft.auto_archive_days': def(z.number().int().positive(), 30, 'FR-1.6 · ноорог автоматаар архивлах хоног'),
  'stress.rate_delta': def(z.number(), 0.05, 'FR-8.5 · stress test — хүү өсөх (+5 п.п.)'),
  'stress.income_delta': def(z.number(), -0.2, 'FR-8.5 · stress test — орлого буурах (−20%)'),
  'schedule.day_count': def(z.enum(['30/360', 'ACT/365']), '30/360', 'FR-7 · хоногийн тооцооны суурь'),
  'approval.default_sla_hours': def(z.number().int().positive(), 24, 'FR-10.2 · батлах түвшний SLA (цаг)'),
  // ── BSA (docs/02 §4, §5) ──
  'bsa.cogs_rate_default': def(z.number().min(0).max(1), 0.1, 'BSA-BR-1 · ББӨ'),
  'bsa.dti_level_low_max': def(z.number().min(0).max(1), 0.35, 'BSA-BR-2 · DTI "Бага" түвшний дээд'),
  'bsa.dti_level_medium_max': def(z.number().min(0).max(1), 0.55, 'BSA-BR-2 · DTI "Дунд" түвшний дээд (давбал "Өндөр")'),
  'bsa.period_options_months': def(z.array(z.number().int().positive()), [3, 6, 12], 'BSA-BR-3 · шинжилгээний хугацааны сонголт'),
  'bsa.other_category_warn_ratio': def(z.number().min(0).max(1), 0.3, 'BSA-BR-7 · "Бусад" ангиллын анхааруулах хувь'),
  'bsa.retention_years': def(z.number().int().positive(), 3, 'BSA-BR-8 · хуулга, гүйлгээ хадгалах жил'),
  'bsa.pull_with_pending_suspicion': def(z.enum(['WARN', 'BLOCK']), 'WARN', 'BSA-FR-5.3 · хүлээгдэж буй сэжигтэйтэй LOS руу татах'),
  'bsa.signal.quick_cash_minutes': def(z.number().int().positive(), 30, 'Хурдан бэлэн авалт — орлогын дараах цагийн зөрүү (минут)'),
  'bsa.signal.split_withdrawal_window_hours': def(z.number().int().positive(), 24, 'Хуваан авалт — цонх (цаг)'),
  'bsa.signal.split_withdrawal_min_count': def(z.number().int().positive(), 3, 'Хуваан авалт — хамгийн цөөн давталт'),
  'bsa.signal.structuring_threshold_amount': def(z.number().positive(), 20_000_000, 'Бүтэцлэгдсэн төлбөр — босго дүн (₮)'),
  'bsa.signal.structuring_margin': def(z.number().min(0).max(1), 0.1, 'Бүтэцлэгдсэн төлбөр — босгын ойролцоо гэж үзэх хувь'),
  'bsa.signal.circular_amount_tolerance': def(z.number().min(0).max(1), 0.02, 'Тойрог шилжүүлэг — дүнгийн зөрүүний хувь'),
  'bsa.signal.circular_window_days': def(z.number().int().positive(), 3, 'Тойрог шилжүүлэг — хугацааны зөрүү (хоног)'),
  'bsa.signal.inter_account_min_repeat': def(z.number().int().positive(), 3, 'Данс хоорондын залилан — хамгийн цөөн давталт'),
  'bsa.signal.collusion_min_counterparties': def(z.number().int().positive(), 5, 'Хамтарсан залилан — кластерын хамгийн цөөн данс'),
  'bsa.signal.gambling_keywords': def(z.array(z.string()), ['casino', 'bet', 'betting', 'казино', 'бооцоо', 'ставка'], 'Мөрийтэй тоглоом — утгын түлхүүр үгс'),
  // ── Хамтран зээлдэгч, төлбөр, мэдэгдэл, тайлан (docs/05-borrower-payment-notification-report.md; DEMO таамаг — docs/DECISIONS.md) ──
  'borrower.max_co_borrowers': def(z.number().int().min(0), 3, 'Хүсэлтэд оруулах хамтран зээлдэгчийн дээд тоо'),
  'borrower.max_guarantors': def(z.number().int().min(0), 3, 'Хүсэлтэд оруулах батлан даагчийн дээд тоо'),
  'payment.invoice_ttl_minutes': def(z.number().int().positive(), 60, 'Төлбөрийн invoice хүчинтэй байх хугацаа (минут)'),
  'payment.min_amount': def(z.number().positive(), 1000, 'Нэг удаагийн төлбөрийн доод дүн (₮)'),
  'payment.collection_account': def(z.object({ bankCode: z.string(), accountNo: z.string(), accountName: z.string() }), { bankCode: '', accountNo: '', accountName: '' }, 'Банкны шилжүүлгээр хүлээн авах данс'),
  'notification.reminder_before_due_days': def(z.array(z.number().int().min(0)), [3, 1, 0], 'Төлбөрийн сануулга — хугацаанаас өмнөх хоногууд'),
  'notification.reminder_overdue_days': def(z.array(z.number().int().positive()), [1, 3, 7], 'Төлбөрийн сануулга — хугацаа хэтэрсний дараах хоногууд'),
  'notification.max_attempts': def(z.number().int().positive(), 5, 'Мэдэгдэл илгээх дээд оролдлого'),
  'notification.channels_customer': def(z.array(z.enum(['SMS', 'EMAIL', 'PUSH'])), ['SMS', 'EMAIL', 'PUSH'], 'Зээлдэгчид мэдэгдэх идэвхтэй сувгууд'),
  'report.max_export_rows': def(z.number().int().positive(), 50_000, 'Excel экспортын дээд мөрийн тоо'),
  // ── Барьцаа, үнэлгээ (docs/05-collateral-documents.md; DEMO таамаг — docs/DECISIONS.md) ──
  'valuation.internal_validity_days': def(z.number().int().positive(), 90, 'FR-14.3 · дотоод үнэлгээ хүчинтэй байх хоног'),
  'valuation.external_validity_days': def(z.number().int().positive(), 365, 'FR-14.3 · гадны (лицензтэй) үнэлгээ хүчинтэй байх хоног'),
  'collateral.revaluation_interval_days': def(z.number().int().positive(), 365, 'FR-6.9 · барьцааг дахин үнэлэх давтамж (хоног)'),
  'collateral.insurance_reminder_days': def(z.number().int().min(0), 30, 'FR-6.9 · даатгал дуусахаас өмнө сануулах хоног'),
} as const;

export type SettingKey = keyof typeof SETTING_REGISTRY;
export const SETTING_KEYS = Object.keys(SETTING_REGISTRY) as SettingKey[];
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_REGISTRY)[K]['schema']>;
export const isSettingKey = (k: string): k is SettingKey => k in SETTING_REGISTRY;
/** Хадгалах/сервисээс унших утгыг баталгаажуулна; бүртгэлгүй түлхүүр дээр throw. */
export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return SETTING_REGISTRY[key].schema.parse(value) as SettingValue<K>;
}
