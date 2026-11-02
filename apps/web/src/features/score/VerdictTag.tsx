'use client';
import type { ReactElement } from 'react';
import { CheckCircleFilled, CloseCircleFilled, MinusCircleFilled } from '@ant-design/icons';
import { Tag } from 'antd';
import { t } from '../../lib/i18n';
import { TONE_TAG_COLOR, toneKey, type Tone } from './score.utils';

const ICON: Record<Tone, ReactElement> = {
  pass: <CheckCircleFilled aria-hidden />,
  fail: <CloseCircleFilled aria-hidden />,
  na: <MinusCircleFilled aria-hidden />,
};

/** FR-8.4: хангасан (ногоон) / хангаагүй (улаан) / хамаарахгүй (саарал). Өнгөөр ганцаараа ялгахгүй — дүрс + текст дагалдана. */
export function VerdictTag({ tone, label }: { tone: Tone; label?: string }) {
  return (
    <Tag color={TONE_TAG_COLOR[tone]} icon={ICON[tone]} data-tone={tone} style={{ marginInlineEnd: 0, whiteSpace: 'normal' }}>
      {label ?? t(toneKey(tone))}
    </Tag>
  );
}

/** Текстгүй орчинд (хүснэгтийн нүд) дүрс: өнгө + хэлбэр, дэлгэц уншигчид тоны нэрийг уншина. */
export function ToneIcon({ tone }: { tone: Tone }) {
  const color = tone === 'pass' ? '#389e0d' : tone === 'fail' ? '#cf1322' : '#8c8c8c';
  const Icon = tone === 'pass' ? CheckCircleFilled : tone === 'fail' ? CloseCircleFilled : MinusCircleFilled;
  return <Icon role="img" aria-label={t(toneKey(tone))} data-tone={tone} style={{ color }} />;
}
