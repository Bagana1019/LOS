'use client';
import { Descriptions } from 'antd';
import type { MyApprovalItem } from '@los/contracts';
import { formatMoney, t } from '../../lib/i18n';

/**
 * FR-1.5: Батлах / Буцаах цонхонд санал өгөгч ЮУНД санал өгч байгааг харуулна — хүсэлтийн дугаар, харилцагч, түвшний нэр (n/N), дүн.
 * Жагсаалт хоцорсон байж болох тул (түвшин ахисан, дахин илгээгдсэн) зөвхөн дугаар харуулахад хангалтгүй. Цэвэр: react-dom/server-ээр тестлэгдэнэ.
 */
export function VoteTargetSummary({ item }: { item: MyApprovalItem }) {
  return (
    <Descriptions size="small" column={1} data-testid="vote-target">
      <Descriptions.Item label={t('application.col.appNo')}>{item.appNo}</Descriptions.Item>
      <Descriptions.Item label={t('application.col.customer')}>{item.borrowerName ?? '—'}</Descriptions.Item>
      <Descriptions.Item label={t('application.mine.col.level')}>{t('application.mine.level', { no: item.levelNo, total: item.totalLevels, name: item.levelName })}</Descriptions.Item>
      <Descriptions.Item label={t('application.col.amount')}>{item.amount == null ? '—' : formatMoney(item.amount, item.currency)}</Descriptions.Item>
    </Descriptions>
  );
}
