'use client';
import type { ReactNode } from 'react';
import { Card, Flex, Progress, Statistic, Typography } from 'antd';
import { CHART_COLORS, type DeltaTone } from './dashboard.utils';

/** Өсөлт нь сайн (олголт, цуглуулалт) — өнгө дан ганц мэдээлэл биш: ▲/▼ тэмдэг, тэмдэгтэй хувь хамт. Ногоон текст 4.5:1+ (success text), улаан 4.6:1. */
const TONE_COLOR: Record<DeltaTone, string> = { up: '#006300', down: '#d03b3b', flat: '#52514e' };
const TONE_MARK: Record<DeltaTone, string> = { up: '▲', down: '▼', flat: '■' };

export interface KpiDelta {
  text: string;
  tone: DeltaTone;
  /** "өмнөх сартай харьцуулахад" гэх мэт. */
  caption: string;
}

interface Props {
  label: string;
  /** Форматласан утга ("1,250,000 ₮", "12.5%", "—"). */
  value: string;
  hint?: ReactNode;
  delta?: KpiDelta;
  /** 0..1 харьцаа бол жижиг прогресс (meter) зурна. */
  meter?: number | null;
}

export function KpiCard({ label, value, hint, delta, meter }: Props) {
  return (
    <Card size="small" style={{ height: '100%' }}>
      <Statistic title={label} value={value} valueStyle={{ fontSize: 24, fontWeight: 600 }} />
      <Flex vertical gap={2} style={{ marginTop: 4 }}>
        {meter !== undefined && meter !== null ? (
          <Progress percent={Math.round(Math.min(1, Math.max(0, meter)) * 1000) / 10} showInfo={false} size="small" strokeColor={CHART_COLORS.accent} aria-label={label} />
        ) : null}
        {delta ? (
          <Typography.Text style={{ color: TONE_COLOR[delta.tone], fontSize: 12 }}>
            {TONE_MARK[delta.tone]} {delta.text} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{delta.caption}</Typography.Text>
          </Typography.Text>
        ) : null}
        {hint ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text> : null}
      </Flex>
    </Card>
  );
}
