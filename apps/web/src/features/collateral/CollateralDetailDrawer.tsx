'use client';
import type { CSSProperties } from 'react';
import { EllipsisOutlined } from '@ant-design/icons';
import { Drawer, Tabs, Tag } from 'antd';
import type { CollateralView } from '@los/contracts';
import { t } from '../../lib/i18n';
import type { WriteState } from '../documents/shared/access';
import { ChecksTab } from './ChecksTab';
import { DocumentsTab } from './DocumentsTab';
import { OverviewTab } from './OverviewTab';
import { RegistryTab } from './RegistryTab';
import { ValuationTab } from './ValuationTab';
import { describeCollateral } from './collateral.fields';
import { assetTypeKey, type DetailTab } from './collateral.utils';

const VISUALLY_HIDDEN: CSSProperties = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };

interface Props {
  applicationId: string;
  item: CollateralView | null;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  onClose: () => void;
  write: WriteState;
  onEdit: () => void;
  onRemove: () => void;
  removing: boolean;
  onChanged?: () => void;
}

/** Барьцааны дэлгэрэнгүй самбар (Drawer, Esc-ээр хаагдана): тойм · шалгалт · үнэлгээ · баримт · ЭБ. */
export function CollateralDetailDrawer({ applicationId, item, tab, onTab, onClose, write, onEdit, onRemove, removing, onChanged }: Props) {
  const common = item ? { applicationId, item, write, onChanged } : null;
  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      destroyOnHidden
      styles={{ wrapper: { width: 'min(760px, 100vw)' } }}
      title={item ? <span><Tag color="blue">{t(assetTypeKey(item.assetType))}</Tag>{describeCollateral(item.assetType, item.description)}</span> : null}
    >
      {item && common ? (
        <Tabs
          size="small"
          tabBarGutter={16}
          // Нарийн дэлгэц дээр табууд багтахгүй бол antd «…» товч гарна — нэргүй товч дэлгэцийн уншигчид хэрэггүй тул далд текст өгнө
          more={{ icon: <><EllipsisOutlined aria-hidden="true" /><span style={VISUALLY_HIDDEN}>{t('collateral.tab.more')}</span></> }}
          activeKey={tab}
          onChange={(key) => onTab(key as DetailTab)}
          items={[
            { key: 'overview', label: t('collateral.tab.overview'), children: <OverviewTab {...common} onEdit={onEdit} onRemove={onRemove} removing={removing} /> },
            { key: 'checks', label: t('collateral.tab.checks'), children: <ChecksTab {...common} /> },
            { key: 'valuation', label: t('collateral.tab.valuation'), children: <ValuationTab {...common} /> },
            { key: 'documents', label: t('collateral.tab.documents'), children: <DocumentsTab {...common} /> },
            { key: 'registry', label: t('collateral.tab.registry'), children: <RegistryTab {...common} /> },
          ]}
        />
      ) : null}
    </Drawer>
  );
}
