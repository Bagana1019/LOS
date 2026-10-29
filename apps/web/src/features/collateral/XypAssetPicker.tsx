'use client';
import { Button, Card, Empty, Flex, List, Skeleton, Tag, Typography } from 'antd';
import type { CollateralCandidate } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { describeCollateral } from './collateral.fields';
import { assetTypeKey } from './collateral.utils';
import { useXypAssets } from './useCollateral';

interface Props {
  applicationId: string;
  ownerCustomerId: string;
  onPick: (candidate: CollateralCandidate) => void;
  onClose: () => void;
}

/** FR-6.3: ХУР-ын бүртгэлтэй (үл хөдлөх, тээврийн хэрэгсэл) хөрөнгөөс сонгож формыг урьдчилан бөглөнө. Өөр хүсэлтэд барьцаалагдсан нь сонгогдохгүй. */
export function XypAssetPicker({ applicationId, ownerCustomerId, onPick, onClose }: Props) {
  const q = useXypAssets(applicationId, ownerCustomerId);
  return (
    <Card size="small" title={t('collateral.xyp.title')} extra={<Button size="small" type="text" onClick={onClose}>{t('collateral.action.close')}</Button>} data-testid="xyp-picker">
      {q.isPending ? (
        <Skeleton active paragraph={{ rows: 2 }} />
      ) : q.isError ? (
        <ApiErrorAlert error={q.error} scope="collateral" onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('collateral.xyp.empty')} />
      ) : (
        <List
          size="small"
          dataSource={q.data.items}
          renderItem={(c) => {
            const summary = describeCollateral(c.assetType, c.description);
            return (
              <List.Item
                key={c.xypRef}
                actions={[
                  <Button key="pick" size="small" type="primary" ghost disabled={c.alreadyPledged} onClick={() => onPick(c)} aria-label={`${t('collateral.xyp.pick')}: ${c.label}`}>
                    {t('collateral.xyp.pick')}
                  </Button>,
                ]}
              >
                <Flex vertical gap={2}>
                  <Flex gap={8} align="center" wrap>
                    <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t(assetTypeKey(c.assetType))}</Tag>
                    <Typography.Text strong>{c.label}</Typography.Text>
                    {c.alreadyPledged ? <Tag color="warning" style={{ marginInlineEnd: 0 }}>{t('collateral.xyp.alreadyPledged')}</Tag> : null}
                  </Flex>
                  <Typography.Text type="secondary">{summary}</Typography.Text>
                </Flex>
              </List.Item>
            );
          }}
        />
      )}
      <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>{t('collateral.xyp.demoNote')}</Typography.Paragraph>
    </Card>
  );
}
