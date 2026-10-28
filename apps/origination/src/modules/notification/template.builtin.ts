import type { NotificationChannel, NotificationType } from '@los/contracts';

// FR-13.2: кодонд суулгасан анхдагч (монгол) загварууд. Админ `notification_template`-ээр дарж болно (идэвхтэй бол тэр нь давамгайлна).
// Placeholder: {{borrowerName}} {{amount}} {{currency}} {{dueDate}} {{contractNo}} {{applicationNo}} {{daysOverdue}} {{comment}}
// SMS: кирилл нь UCS-2 тул ≤ 2 сегмент (≈ 134 тэмдэгт) — template.builtin.test.ts-д хамгийн урт утгаар шалгадаг.

export interface BuiltinTemplate { subject: string | null; body: string }

const SIGN = '\n\nХүндэтгэсэн,\nЗээлийн үйлчилгээний баг';

/** Зээлдэгчид чиглэсэн төрлүүд: SMS + EMAIL + PUSH. */
export const CUSTOMER_TYPES = ['APPROVED', 'DISBURSEMENT_APPROVED', 'PAYMENT_DUE', 'PAYMENT_OVERDUE', 'PAYMENT_RECEIVED'] as const satisfies readonly NotificationType[];

const CUSTOMER_CHANNELS: Record<(typeof CUSTOMER_TYPES)[number], Record<'SMS' | 'EMAIL' | 'PUSH', BuiltinTemplate>> = {
  APPROVED: {
    SMS: { subject: null, body: '{{borrowerName}}, таны {{amount}} {{currency}}-ийн зээл батлагдлаа. Гэрээний дугаар: {{contractNo}}.' },
    EMAIL: {
      subject: 'Таны зээлийн хүсэлт батлагдлаа',
      body: `Сайн байна уу, {{borrowerName}}.\n\nТаны {{applicationNo}} дугаартай {{amount}} {{currency}}-ийн зээлийн хүсэлт батлагдлаа.\nГэрээний дугаар: {{contractNo}}.\n\nГэрээ байгуулах талаар манай ажилтан тантай холбогдоно.${SIGN}`,
    },
    PUSH: { subject: 'Зээл батлагдлаа', body: 'Таны {{amount}} {{currency}}-ийн зээлийн хүсэлт батлагдлаа. Гэрээ №{{contractNo}}.' },
  },
  DISBURSEMENT_APPROVED: {
    SMS: { subject: null, body: '{{borrowerName}}, таны {{contractNo}} гэрээний {{amount}} {{currency}} зээлийн олголт зөвшөөрөгдлөө.' },
    EMAIL: {
      subject: 'Таны зээлийн олголт зөвшөөрөгдлөө',
      body: `Сайн байна уу, {{borrowerName}}.\n\nТаны {{contractNo}} дугаартай гэрээний {{amount}} {{currency}}-ийн зээлийн олголт зөвшөөрөгдлөө.\nМөнгө таны дансанд орсон даруй танд мэдэгдэнэ.${SIGN}`,
    },
    PUSH: { subject: 'Зээлийн олголт зөвшөөрөгдлөө', body: '{{contractNo}} гэрээний {{amount}} {{currency}} олголт зөвшөөрөгдлөө.' },
  },
  PAYMENT_DUE: {
    SMS: { subject: null, body: '{{borrowerName}}, таны {{contractNo}} зээлийн {{amount}} {{currency}} төлбөрийн хугацаа {{dueDate}}.' },
    EMAIL: {
      subject: 'Зээлийн төлбөр төлөх хугацаа ойртлоо',
      body: `Сайн байна уу, {{borrowerName}}.\n\nТаны {{contractNo}} дугаартай зээлийн {{amount}} {{currency}}-ийн төлбөрийг {{dueDate}}-ны дотор төлөх ёстой.\nХугацаандаа төлснөөр торгууль, хүү нэмэгдэхгүй.${SIGN}`,
    },
    PUSH: { subject: 'Төлбөр төлөх хугацаа', body: '{{contractNo}} зээлийн {{amount}} {{currency}} төлбөрийн хугацаа {{dueDate}}.' },
  },
  PAYMENT_OVERDUE: {
    SMS: { subject: null, body: '{{borrowerName}}, таны {{contractNo}} зээлийн {{amount}} {{currency}} төлбөр {{daysOverdue}} хоногоор хэтэрсэн. Яаралтай төлнө үү.' },
    EMAIL: {
      subject: 'Зээлийн төлбөр хугацаа хэтэрсэн',
      body: `Сайн байна уу, {{borrowerName}}.\n\nТаны {{contractNo}} дугаартай зээлийн {{dueDate}}-нд төлөх ёстой {{amount}} {{currency}}-ийн төлбөр {{daysOverdue}} хоногоор хэтэрсэн байна.\nТөлбөрөө яаралтай төлнө үү. Асуух зүйл байвал манай ажилтантай холбогдоно уу.${SIGN}`,
    },
    PUSH: { subject: 'Төлбөр хугацаа хэтэрсэн', body: '{{contractNo}} зээлийн {{amount}} {{currency}} төлбөр {{daysOverdue}} хоногоор хэтэрсэн.' },
  },
  PAYMENT_RECEIVED: {
    SMS: { subject: null, body: '{{borrowerName}}, таны {{contractNo}} зээлд {{amount}} {{currency}} төлбөр хүлээн авлаа. Баярлалаа.' },
    EMAIL: {
      subject: 'Төлбөр хүлээн авлаа',
      body: `Сайн байна уу, {{borrowerName}}.\n\nТаны {{contractNo}} дугаартай зээлд {{amount}} {{currency}}-ийн төлбөр хүлээн авлаа. Баярлалаа.${SIGN}`,
    },
    PUSH: { subject: 'Төлбөр хүлээн авлаа', body: '{{contractNo}} зээлд {{amount}} {{currency}} төлбөр орлоо.' },
  },
};

/** Ажилтны хонх (in-app): title = subject. Бүх 9 төрөлд. */
const IN_APP: Record<NotificationType, BuiltinTemplate> = {
  APPROVAL_REQUESTED: { subject: 'Батлах хүсэлт ирлээ', body: '{{applicationNo}} дугаартай хүсэлтийг батлах шаардлагатай.' },
  RETURNED: { subject: 'Хүсэлт буцаагдлаа', body: '{{applicationNo}} дугаартай хүсэлт буцаагдлаа. Тайлбар: {{comment}}' },
  APPROVED: { subject: 'Хүсэлт батлагдлаа', body: '{{applicationNo}} дугаартай хүсэлт батлагдлаа. Гэрээний дугаар: {{contractNo}}.' },
  DISBURSEMENT_APPROVED: { subject: 'Олголт зөвшөөрөгдлөө', body: '{{applicationNo}} дугаартай хүсэлтийн {{amount}} {{currency}} олголт зөвшөөрөгдлөө.' },
  SLA_BREACH: { subject: 'Шийдвэрлэх хугацаа хэтэрлээ', body: '{{applicationNo}} дугаартай хүсэлтийн шийдвэрлэх хугацаа хэтэрсэн байна.' },
  MENTION: { subject: 'Таныг дурдлаа', body: '{{applicationNo}} дугаартай хүсэлтийн тайлбарт таныг дурдсан: {{comment}}' },
  PAYMENT_DUE: { subject: 'Төлбөрийн хугацаа ойртлоо', body: '{{contractNo}} зээлийн {{amount}} {{currency}} төлбөр {{dueDate}}-нд төлөгдөх ёстой.' },
  PAYMENT_OVERDUE: { subject: 'Зээлийн төлбөр хэтэрлээ', body: '{{contractNo}} ({{applicationNo}}) зээлийн {{amount}} {{currency}} төлбөр {{daysOverdue}} хоногоор хэтэрсэн.' },
  PAYMENT_RECEIVED: { subject: 'Төлбөр хүлээн авлаа', body: '{{contractNo}} зээлд {{amount}} {{currency}} төлбөр орлоо.' },
};

export const BUILTIN_LOCALE = 'mn';

/** Кодонд суулгасан бүх загвар: type × channel (locale = 'mn'). */
export function builtinTemplates(): Array<{ type: NotificationType; channel: NotificationChannel; locale: string } & BuiltinTemplate> {
  const out: Array<{ type: NotificationType; channel: NotificationChannel; locale: string } & BuiltinTemplate> = [];
  for (const type of Object.keys(IN_APP) as NotificationType[]) {
    out.push({ type, channel: 'IN_APP', locale: BUILTIN_LOCALE, ...IN_APP[type] });
    const customer = (CUSTOMER_TYPES as readonly string[]).includes(type) ? CUSTOMER_CHANNELS[type as (typeof CUSTOMER_TYPES)[number]] : null;
    if (customer) for (const channel of ['SMS', 'EMAIL', 'PUSH'] as const) out.push({ type, channel, locale: BUILTIN_LOCALE, ...customer[channel] });
  }
  return out;
}

export function builtinTemplate(type: NotificationType, channel: NotificationChannel, locale: string): BuiltinTemplate | null {
  if (locale !== BUILTIN_LOCALE) return null;
  if (channel === 'IN_APP') return IN_APP[type] ?? null;
  const customer = (CUSTOMER_TYPES as readonly string[]).includes(type) ? CUSTOMER_CHANNELS[type as (typeof CUSTOMER_TYPES)[number]] : null;
  return customer ? customer[channel] : null;
}
