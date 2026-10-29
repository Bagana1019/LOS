'use client';
import { Flex, Typography, theme } from 'antd';
import type { BarRow } from './dashboard.utils';

interface Props {
  rows: readonly BarRow[];
  /** Дэлгэц уншигчид диаграмын нэр. */
  label: string;
}

/**
 * Хэвтээ мөрт диаграм (thin bar ≤ 12px, зөвхөн төгсгөл нь 4px дугуй, суурь нь тэгш). Нэр + утга нь үргэлж текстээр (өнгө дангаараа мэдээлэл биш).
 * Aging, төлөвийн урсгал, топ бүтээгдэхүүнд нийтлэг.
 */
export function BarList({ rows, label }: Props) {
  const { token } = theme.useToken();
  return (
    <ul aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', rowGap: 12 }}>
      {rows.map((r) => (
        <li key={r.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 150px) minmax(60px, 1fr) minmax(130px, 210px)', columnGap: 12, alignItems: 'center' }}>
          <Typography.Text ellipsis={{ tooltip: r.label }} style={{ color: token.colorText }}>{r.label}</Typography.Text>
          <div role="img" aria-label={`${r.label}: ${r.primary}, ${r.secondary}`} style={{ height: 10, background: token.colorFillTertiary, borderRadius: '0 4px 4px 0' }}>
            <div style={{ width: `${r.ratio > 0 ? Math.max(r.ratio * 100, 1) : 0}%`, height: '100%', background: r.color, borderRadius: '0 4px 4px 0' }} />
          </div>
          <Flex vertical align="end" style={{ lineHeight: 1.3 }}>
            <Typography.Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{r.primary}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.secondary}</Typography.Text>
          </Flex>
        </li>
      ))}
    </ul>
  );
}
