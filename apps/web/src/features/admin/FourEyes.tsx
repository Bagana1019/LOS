'use client';
// Q-124 · 4 нүдний (Maker-Checker) нийтлэг хэсэг: хүлээгдэж буй саналын анхааруулга + шалтгаан оруулах талбар + илгээсний дараах мэдэгдэл.
import Link from 'next/link';
import { Alert, Input, Typography } from 'antd';
import type { SubmitChangeResult } from '@los/contracts';
import { t } from '../../lib/i18n';
import { usePendingChanges } from './admin.hooks';

export const REASON_MIN = 3;
export const reasonOk = (s: string) => [...s.trim()].length >= REASON_MIN;

/** Тухайн төрлийн PENDING санал байвал анхааруулж `/los/maker-checker`-ийн хүсэлт рүү холбоно. `targetId` өгвөл зөвхөн тэр зорилтыг. */
export function PendingChangeNotice({ targetType, targetId }: { targetType: string; targetId?: string }) {
  const q = usePendingChanges(targetType);
  const items = (q.data ?? []).filter((r) => !targetId || r.targetId === targetId);
  if (items.length === 0) return null;
  const first = items[0]!;
  return (
    <Alert
      type="warning" showIcon
      message={t('admin.four_eyes.pending.title')}
      description={(
        <>
          {t('admin.four_eyes.pending.body')}{' '}
          <Link href={`/los/maker-checker?tab=all&id=${encodeURIComponent(first.id)}`}>{t('admin.four_eyes.pending.link')}</Link>
        </>
      )}
    />
  );
}

/** Maker-ийн шалтгаан (MC-BR-4: ≥3 тэмдэгт) */
export function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Typography.Text strong>{t('admin.four_eyes.reason.label')}</Typography.Text>
      <Input.TextArea
        rows={2} maxLength={2000} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={t('admin.four_eyes.reason.placeholder')} status={value && !reasonOk(value) ? 'error' : undefined}
      />
    </div>
  );
}

/** Илгээсний дараах мессеж: PENDING = батлагч хүлээж байна; APPLIED_DIRECT = бодлого идэвхгүй тул шууд хэрэгжсэн */
export const submittedText = (r: SubmitChangeResult, appliedKey: string) => t(r.outcome === 'PENDING' ? 'admin.four_eyes.submitted' : appliedKey);
