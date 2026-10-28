import { BadRequestException, Injectable } from '@nestjs/common';
import { NotificationChannel, NotificationType, type PreviewTemplateRequest, type PreviewTemplateResponse, type TemplateView, type UpsertTemplateRequest } from '@los/contracts';
import { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { BUILTIN_LOCALE, builtinTemplate, builtinTemplates } from './template.builtin';
import { findInvalidPlaceholders, renderText, smsSegments, textToHtml, type TemplateVars } from './template.render';

export interface RenderedMessage { subject: string | null; body: string; html: string | null }

/** Нэг байгууллагын override-уудыг урьдчилан ачаалсан render хийгч — олон хүлээн авагчид sync render хийхэд. */
export interface TemplateResolver {
  render(type: NotificationType, channel: NotificationChannel, locale: string | undefined, vars: TemplateVars): RenderedMessage | null;
}

// Админ загвар үзэхэд/туршихад ашиглах жишээ утгууд.
export const SAMPLE_VARS: TemplateVars = {
  borrowerName: 'Болд', amount: 1_200_000, currency: 'MNT', dueDate: '2026-11-28', contractNo: 'BZ-2026-000123', applicationNo: 'APP-2026-000123', daysOverdue: 3, comment: 'Орлогын баримт дутуу байна',
};

const typeOrder = (t: string) => NotificationType.indexOf(t as NotificationType);
const channelOrder = (c: string) => NotificationChannel.indexOf(c as NotificationChannel);

@Injectable()
export class TemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async resolver(orgId: string): Promise<TemplateResolver> {
    const overrides = await this.prisma.notificationTemplate.findMany({ where: { orgId, isActive: true } });
    const byKey = new Map(overrides.map((o) => [`${o.type}|${o.channel}|${o.locale}`, o]));
    const find = (type: NotificationType, channel: NotificationChannel, locale?: string) => {
      for (const loc of locale && locale !== BUILTIN_LOCALE ? [locale, BUILTIN_LOCALE] : [BUILTIN_LOCALE]) {
        const o = byKey.get(`${type}|${channel}|${loc}`);
        if (o) return { subject: o.subject, body: o.body };
        const b = builtinTemplate(type, channel, loc);
        if (b) return b;
      }
      return null;
    };
    return {
      render: (type, channel, locale, vars) => {
        const t = find(type, channel, locale);
        return t ? this.build(channel, t.subject, t.body, vars) : null;
      },
    };
  }

  async render(orgId: string, type: NotificationType, channel: NotificationChannel, locale: string | undefined, vars: TemplateVars): Promise<RenderedMessage | null> {
    return (await this.resolver(orgId)).render(type, channel, locale, vars);
  }

  /** Кодонд суулгасан + override нийлүүлсэн жагсаалт (type, channel, locale дарааллаар). Override байвал (идэвхгүй ч) түүнийг харуулна. */
  async list(orgId: string): Promise<TemplateView[]> {
    const overrides = await this.prisma.notificationTemplate.findMany({ where: { orgId } });
    const views = new Map<string, TemplateView>();
    for (const b of builtinTemplates()) {
      views.set(`${b.type}|${b.channel}|${b.locale}`, { id: null, type: b.type, channel: b.channel, locale: b.locale, subject: b.subject, body: b.body, isActive: true, isBuiltin: true });
    }
    for (const o of overrides) {
      const type = o.type as NotificationType; const channel = o.channel as NotificationChannel;
      views.set(`${o.type}|${o.channel}|${o.locale}`, { id: o.id, type, channel, locale: o.locale, subject: o.subject, body: o.body, isActive: o.isActive, isBuiltin: builtinTemplate(type, channel, o.locale) !== null });
    }
    return [...views.values()].sort((a, b) => typeOrder(a.type) - typeOrder(b.type) || channelOrder(a.channel) - channelOrder(b.channel) || a.locale.localeCompare(b.locale));
  }

  /** (org, type, channel, locale) нэг override. Placeholder-ийн хүчинтэй эсэхийг шалгана (400 INVALID_PLACEHOLDER). */
  async upsert(orgId: string, userId: string | null, dto: UpsertTemplateRequest): Promise<TemplateView> {
    this.validate(dto.channel, dto.subject, dto.body);
    const subject = dto.channel === 'SMS' ? null : dto.subject?.trim() || null;
    const key = { orgId_type_channel_locale: { orgId, type: dto.type, channel: dto.channel, locale: dto.locale } };
    const data = { subject, body: dto.body, isActive: dto.isActive, updatedBy: userId };
    let row;
    try {
      row = await this.prisma.notificationTemplate.upsert({ where: key, create: { orgId, type: dto.type, channel: dto.channel, locale: dto.locale, createdBy: userId, ...data }, update: data });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      row = await this.prisma.notificationTemplate.update({ where: key, data }); // зэрэг PUT: нөгөө нь дөнгөж үүсгэсэн
    }
    return { id: row.id, type: dto.type, channel: dto.channel, locale: row.locale, subject: row.subject, body: row.body, isActive: row.isActive, isBuiltin: builtinTemplate(dto.type, dto.channel, row.locale) !== null };
  }

  /** Хадгалахгүйгээр жишээ утгаар render. Үл мэдэгдэх placeholder-ийг алдаа биш, жагсаалтаар хэлнэ. */
  preview(dto: PreviewTemplateRequest): PreviewTemplateResponse {
    const unknown = findInvalidPlaceholders(dto.subject, dto.body);
    const rendered = this.build(dto.channel, dto.subject ?? null, dto.body, SAMPLE_VARS);
    return { subject: rendered.subject, body: rendered.body, html: rendered.html, unknownPlaceholders: unknown, smsSegments: dto.channel === 'SMS' ? smsSegments(rendered.body).segments : null };
  }

  private validate(channel: NotificationChannel, subject: string | null | undefined, body: string): void {
    const invalid = findInvalidPlaceholders(subject, body);
    if (invalid.length) {
      throw new BadRequestException({ code: 'INVALID_PLACEHOLDER', message: `Загварт зөвшөөрөгдөөгүй placeholder байна: ${invalid.join(', ')}`, details: { placeholders: invalid } });
    }
    if (channel !== 'SMS' && !subject?.trim()) {
      throw new BadRequestException({ code: 'SUBJECT_REQUIRED', message: 'Энэ сувгийн загварт гарчиг заавал байх ёстой' });
    }
  }

  private build(channel: NotificationChannel, subject: string | null, body: string, vars: TemplateVars): RenderedMessage {
    const text = renderText(body, vars);
    const title = channel === 'SMS' ? null : subject ? renderText(subject, vars) : null;
    return { subject: title, body: text, html: channel === 'EMAIL' ? textToHtml(text) : null };
  }
}
