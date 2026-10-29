'use client';
import { useMemo, useState } from 'react';
import { Empty, Flex, Segmented, Table, theme } from 'antd';
import type { DashboardSummary } from '@los/contracts';
import { t } from '../../lib/i18n';
import {
  CHART_COLORS, formatCompact, isMonthlyEmpty, layoutMonthlyBars, monthAxisLabel, niceScale, roundedTopBarPath,
} from './dashboard.utils';
import { formatMoneyValue, formatNumberValue } from './reports.utils';

type Monthly = DashboardSummary['disbursements']['monthly'];

// SVG-ийн координатын орон зай (viewBox). Контейнерт өргөнөөр нь тохирно.
const W = 720;
const H = 300;
const M = { top: 22, right: 12, bottom: 46, left: 76 };
const PLOT = { width: W - M.left - M.right, height: H - M.top - M.bottom };

interface Props {
  monthly: Monthly;
  currency: string;
}

/** Сүүлийн 12 сарын олголт (багана). Нэг цуваа тул легендгүй; сүүлийн сарын утгыг шууд шошголно, бусад нь tooltip/хүснэгтээр. Hover/фокус tooltip, "Хүснэгтээр харах" хувилбартай. */
export function MonthlyDisbursementChart({ monthly, currency }: Props) {
  const { token } = theme.useToken();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [active, setActive] = useState<number | null>(null);

  const empty = isMonthlyEmpty(monthly);
  const scale = useMemo(() => niceScale(Math.max(0, ...monthly.map((m) => m.amount))), [monthly]);
  const bars = useMemo(() => layoutMonthlyBars(monthly, PLOT, scale.max), [monthly, scale.max]);

  if (empty) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report.chart.empty')} />;

  const toggle = (
    <Segmented
      size="small"
      value={view}
      onChange={(v) => setView(v as 'chart' | 'table')}
      options={[{ label: t('report.chart.view.chart'), value: 'chart' }, { label: t('report.chart.view.table'), value: 'table' }]}
    />
  );

  if (view === 'table') {
    return (
      <Flex vertical gap={12}>
        <Flex justify="end">{toggle}</Flex>
        <Table
          size="small"
          rowKey="month"
          pagination={false}
          dataSource={[...monthly]}
          columns={[
            { key: 'month', dataIndex: 'month', title: t('report.chart.col.month') },
            { key: 'amount', dataIndex: 'amount', title: t('report.chart.col.amount'), align: 'right', render: (v: number) => formatMoneyValue(v, currency) },
            { key: 'count', dataIndex: 'count', title: t('report.chart.col.count'), align: 'right', render: (v: number) => formatNumberValue(v, 0) },
          ]}
        />
      </Flex>
    );
  }

  const hovered = active !== null ? bars[active] : null;
  const last = bars.length - 1;

  return (
    <Flex vertical gap={8}>
      <Flex justify="end">{toggle}</Flex>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="group" aria-label={t('report.chart.monthly.aria')} style={{ display: 'block', height: 'auto', maxHeight: 340, fontFamily: 'inherit' }}>
          <g transform={`translate(${M.left},${M.top})`}>
            {scale.ticks.map((tick) => {
              const y = PLOT.height - (tick / scale.max) * PLOT.height;
              return (
                <g key={tick}>
                  <line x1={0} x2={PLOT.width} y1={y} y2={y} stroke={tick === 0 ? token.colorBorder : token.colorSplit} strokeWidth={1} />
                  <text x={-8} y={y + 4} textAnchor="end" fontSize={11} fill={token.colorTextTertiary}>{formatCompact(tick, t)}</text>
                </g>
              );
            })}

            {bars.map((b, i) => {
              const axis = monthAxisLabel(b.month, i, t);
              const isActive = active === i;
              return (
                <g key={b.month}>
                  {isActive ? <rect x={b.bandX} y={0} width={b.bandWidth} height={PLOT.height} fill={token.colorFillQuaternary} /> : null}
                  {b.height > 0 ? <path d={roundedTopBarPath(b.x, b.y, b.width, b.height, 4)} fill={isActive ? CHART_COLORS.accentStrong : CHART_COLORS.accent} /> : null}
                  <text x={b.cx} y={PLOT.height + 16} textAnchor="middle" fontSize={11} fill={token.colorTextSecondary}>{axis.month}</text>
                  {axis.year ? <text x={b.cx} y={PLOT.height + 32} textAnchor="middle" fontSize={11} fill={token.colorTextTertiary}>{axis.year}</text> : null}
                  {i === last && b.amount > 0 ? <text x={b.cx} y={b.y - 6} textAnchor="middle" fontSize={12} fontWeight={600} fill={token.colorText}>{formatCompact(b.amount, t)}</text> : null}
                  <rect
                    x={b.bandX}
                    y={0}
                    width={b.bandWidth}
                    height={PLOT.height}
                    fill="transparent"
                    tabIndex={0}
                    role="img"
                    aria-label={t('report.chart.monthly.point', { month: b.month, amount: formatMoneyValue(b.amount, currency), count: b.count })}
                    onPointerEnter={() => setActive(i)}
                    onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive((a) => (a === i ? null : a))}
                    style={{ outline: 'none', cursor: 'default' }}
                  />
                </g>
              );
            })}
          </g>
        </svg>

        {hovered ? (
          <div
            role="status"
            style={{
              position: 'absolute', pointerEvents: 'none', transform: 'translate(-50%, calc(-100% - 8px))', whiteSpace: 'nowrap', zIndex: 1,
              left: `${((M.left + hovered.cx) / W) * 100}%`, top: `${((M.top + hovered.y) / H) * 100}%`,
              background: token.colorBgElevated, boxShadow: token.boxShadowSecondary, borderRadius: token.borderRadius, padding: '6px 10px', lineHeight: 1.4,
            }}
          >
            <div style={{ fontWeight: 600, color: token.colorText }}>{formatMoneyValue(hovered.amount, currency)}</div>
            <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{hovered.month} · {t('report.chart.monthly.count', { count: hovered.count })}</div>
          </div>
        ) : null}
      </div>
    </Flex>
  );
}
