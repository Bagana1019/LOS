'use client';
import { useRef } from 'react';
import { useElementWidth } from '../hooks';

export interface BarDatum { label: string; value: number; overlay?: number; caption: string }

interface Props {
  title: string;
  data: readonly BarDatum[];
  formatValue: (v: number) => string;
  formatAxis: (v: number) => string;
  color: string;
  overlayColor?: string;
  height?: number;
}

/** Тэнхлэгийн "цэвэр" дээд утга (1/2/2.5/5 × 10^k). Зөвхөн графикийн масштаб — бизнес тооцоолол биш. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

const M = { top: 10, right: 8, bottom: 26, left: 46 };

/** Гараар бичсэн хүртээмжтэй SVG баганан график. SVG нь `aria-hidden`; өгөгдөл нь DailyCharts-ийн хүснэгтэд (screen reader + "Хүснэгтээр харах"). */
export function BarChart({ title, data, formatValue, formatAxis, color, overlayColor, height = 190 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const slot = data.length > 0 ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(32, slot * 0.64));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56))));
  const y = (v: number) => M.top + plotH - (v / max) * plotH;

  return (
    <figure className="mp-chart">
      <figcaption className="mp-chart-title">{title}</figcaption>
      <div ref={ref} className="mp-chart-body">
        {width > 0 ? (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={M.left} x2={width - M.right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'mp-chart-axis' : 'mp-chart-grid'} />
                <text x={M.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="mp-chart-tick">{formatAxis(tick)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = M.left + slot * i + (slot - barW) / 2;
              const h = (d.value / max) * plotH;
              const oh = d.overlay !== undefined ? (d.overlay / max) * plotH : 0;
              return (
                <g key={d.label}>
                  <rect x={x} y={M.top + plotH - h} width={barW} height={Math.max(0, h)} rx={2} fill={color} fillOpacity={overlayColor ? 0.35 : 1}>
                    <title>{`${d.caption}: ${formatValue(d.value)}`}</title>
                  </rect>
                  {overlayColor && oh > 0 ? <rect x={x} y={M.top + plotH - oh} width={barW} height={oh} rx={2} fill={overlayColor} /> : null}
                  {i % labelEvery === 0 ? <text x={x + barW / 2} y={height - 8} textAnchor="middle" className="mp-chart-tick">{d.label}</text> : null}
                </g>
              );
            })}
          </svg>
        ) : (
          <div style={{ height }} />
        )}
      </div>
    </figure>
  );
}
