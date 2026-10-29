'use client';
import type { MerchantDashboard } from '@los/contracts';
import { Button, Card } from 'antd';
import { useState } from 'react';
import { formatMnt, formatMntCompact, formatNumber } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { MP_COLORS } from '../theme';
import { BarChart } from './BarChart';

/** Өдөр тутмын график: хүсэлт (батлагдсан давхарласан) ба санхүүжилт. Хүснэгт нь screen reader-д үргэлж байна; "Хүснэгтээр харах" товчоор бүгдэд харагдана. */
export function DailyCharts({ daily }: { daily: MerchantDashboard['daily'] }) {
  const [asTable, setAsTable] = useState(false);
  const shortDate = (d: string) => d.slice(5);
  const hasData = daily.some((d) => d.requests > 0 || d.financedAmount > 0);
  return (
    <Card
      className="mp-card"
      title={t('dashboard.daily.title')}
      extra={<Button size="small" type="text" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{asTable ? t('dashboard.daily.showChart') : t('dashboard.daily.showTable')}</Button>}
    >
      {!asTable ? (
        <div className="mp-chart-grid-2">
          <BarChart
            title={t('dashboard.daily.requests')}
            data={daily.map((d) => ({ label: shortDate(d.date), value: d.requests, overlay: d.approved, caption: d.date }))}
            formatValue={formatNumber} formatAxis={(v) => formatNumber(v)} color={MP_COLORS.primary} overlayColor={MP_COLORS.primary}
          />
          <BarChart
            title={t('dashboard.daily.financed')}
            data={daily.map((d) => ({ label: shortDate(d.date), value: d.financedAmount, caption: d.date }))}
            formatValue={formatMnt} formatAxis={formatMntCompact} color={MP_COLORS.series2}
          />
        </div>
      ) : null}
      {!asTable ? (
        <ul className="mp-legend" aria-hidden="true">
          <li><i style={{ background: MP_COLORS.primary, opacity: 0.35 }} />{t('dashboard.daily.legendRequests')}</li>
          <li><i style={{ background: MP_COLORS.primary }} />{t('dashboard.daily.legendApproved')}</li>
          <li><i style={{ background: MP_COLORS.series2 }} />{t('dashboard.daily.legendFinanced')}</li>
        </ul>
      ) : null}
      {!hasData && !asTable ? <p className="mp-muted mp-chart-note">{t('dashboard.daily.noData')}</p> : null}
      <div className={asTable ? 'mp-table-wrap' : 'mp-sr-only'}>
        <table className="mp-data-table">
          <caption>{t('dashboard.daily.tableCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('dashboard.daily.col.date')}</th>
              <th scope="col" className="mp-num">{t('dashboard.daily.col.requests')}</th>
              <th scope="col" className="mp-num">{t('dashboard.daily.col.approved')}</th>
              <th scope="col" className="mp-num">{t('dashboard.daily.col.financed')}</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((d) => (
              <tr key={d.date}>
                <th scope="row">{d.date}</th>
                <td className="mp-num">{formatNumber(d.requests)}</td>
                <td className="mp-num">{formatNumber(d.approved)}</td>
                <td className="mp-num">{formatMnt(d.financedAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
