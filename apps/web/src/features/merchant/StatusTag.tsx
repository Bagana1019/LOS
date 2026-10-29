'use client';
import type { MerchantStatus, PosLeaseStatus } from '@los/contracts';
import { Tag } from 'antd';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { MERCHANT_STATUS_COLOR, merchantStatusLabel, STATUS_COLOR, statusLabel } from './status';
import { TAG_TONES, type TagTone } from './tag-tones';

/**
 * Бүх Tag-ийн ганц эх сурвалж: өнгийг preset-ээр биш (`color="gold"` — AA-аас доогуур) `TAG_TONES`-ийн контрастыг шалгасан хос өнгөөр inline зурна.
 * Inline style нь antd-ийн CSS-ийн specificity/injection дараалалд найдахгүй.
 */
export function ToneTag({ tone, children, className }: { tone: TagTone; children: ReactNode; className?: string }) {
  const p = TAG_TONES[tone];
  return <Tag className={className} style={{ color: p.fg, background: p.bg, borderColor: p.border }}>{children}</Tag>;
}

/** Лизингийн төлөв. */
export function StatusTag({ status }: { status: PosLeaseStatus }) {
  return <ToneTag tone={STATUS_COLOR[status]} className="mp-status-tag">{statusLabel(status)}</ToneTag>;
}

/** Мерчантын төлөв (back-office). */
export function MerchantStatusTag({ status }: { status: MerchantStatus }) {
  return <ToneTag tone={MERCHANT_STATUS_COLOR[status]} className="mp-status-tag">{merchantStatusLabel(status)}</ToneTag>;
}

/** Дэлгүүр/хөтөлбөрийн идэвхтэй/идэвхгүй. */
export function ActiveTag({ active }: { active: boolean }) {
  return <ToneTag tone={active ? 'green' : 'default'} className="mp-status-tag">{active ? t('merchant.active') : t('merchant.inactive')}</ToneTag>;
}
