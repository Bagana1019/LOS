import { useState } from 'react';
import { ESignProvider } from '@los/contracts';
import { Alert, Button, Card, Descriptions, Modal, Select, Space, Spin, Tag } from 'antd';
import { formatVerificationCode } from '../esign/flow';
import { formatUlaanbaatar } from '../esign/format';
import { t, type MnKey } from '../esign/i18n';
import { providerName } from '../esign/messages';
import type { StaffSigningView } from './api';
import { failureLabel, statusLabel } from './messages';
import { availableActions, panelStatus, STATUS_COLOR, type PanelStatus } from './status';

const ANY_PROVIDER = 'ANY';

const HINT_KEYS = {
  NONE: 'contractSigning.hint.none',
  PENDING: 'contractSigning.hint.active',
  IN_PROGRESS: 'contractSigning.hint.active',
  FINALIZING: 'contractSigning.hint.finalizing',
  SIGNED: 'contractSigning.hint.signed',
  DECLINED: 'contractSigning.hint.closed',
  EXPIRED: 'contractSigning.hint.closed',
  FAILED: 'contractSigning.hint.closed',
  CANCELLED: 'contractSigning.hint.closed',
} as const satisfies Record<PanelStatus, MnKey>;

export interface PanelViewProps {
  view: StaffSigningView | null;
  loading: boolean;
  /** Аль нэг үйлдэл явагдаж байна — бүх товчийг түгжинэ */
  busy: boolean;
  notice: string | null;
  error: string | null;
  preferred: ESignProvider | null;
  onPreferredChange: (provider: ESignProvider | null) => void;
  onSend: () => void;
  onResend: () => void;
  onCancel: () => void;
  onRefresh: () => void;
}

/** Гэрээний алхамд суулгах самбар. Зээлдэгчийн линкийг (signingUrl) хэзээ ч харуулахгүй. */
export function PanelView(props: PanelViewProps) {
  const { view, loading, busy, notice, error, preferred, onPreferredChange, onSend, onResend, onCancel, onRefresh } = props;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const status = panelStatus(view);
  const actions = availableActions(status);

  return (
    <Card size="small" title={t('contractSigning.title')} extra={<Button size="small" onClick={onRefresh} disabled={loading || busy}>{t('contractSigning.refresh')}</Button>}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {loading ? (
          <Spin tip={t('contractSigning.loading')}>
            <div style={{ height: 48 }} />
          </Spin>
        ) : (
          <>
            <div>
              {t('contractSigning.statusLabel')}: <Tag color={STATUS_COLOR[status]}>{statusLabel(status)}</Tag>
            </div>
            {view !== null && <Details view={view} />}
            <p style={{ margin: 0 }}>{t(HINT_KEYS[status])}</p>
          </>
        )}
        {notice !== null && <Alert type="success" showIcon message={notice} />}
        {error !== null && <Alert type="error" showIcon message={error} />}
        {!loading && (
          <Space wrap>
            {actions.send && (
              <>
                <label>
                  <span style={{ marginRight: 8 }}>{t('contractSigning.providerLabel')}:</span>
                  <Select
                    value={preferred ?? ANY_PROVIDER}
                    style={{ minWidth: 220 }}
                    disabled={busy}
                    onChange={(value: string) => onPreferredChange(value === ANY_PROVIDER ? null : (value as ESignProvider))}
                    options={[{ value: ANY_PROVIDER, label: t('contractSigning.providerAny') }, ...ESignProvider.map((code) => ({ value: code, label: providerName(code) }))]}
                  />
                </label>
                <Button type="primary" loading={busy} onClick={onSend}>
                  {t('contractSigning.send')}
                </Button>
              </>
            )}
            {actions.resend && (
              <Button disabled={busy} onClick={onResend}>
                {t('contractSigning.resend')}
              </Button>
            )}
            {actions.cancel && (
              <Button danger disabled={busy} onClick={() => setConfirmOpen(true)}>
                {t('contractSigning.cancel')}
              </Button>
            )}
          </Space>
        )}
      </Space>
      <Modal
        open={confirmOpen}
        centered
        title={t('contractSigning.cancelConfirmTitle')}
        okText={t('contractSigning.cancelConfirmOk')}
        cancelText={t('contractSigning.cancelConfirmBack')}
        okButtonProps={{ danger: true }}
        onOk={() => {
          setConfirmOpen(false);
          onCancel();
        }}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>{t('contractSigning.cancelConfirmBody')}</p>
      </Modal>
    </Card>
  );
}

function Details({ view }: { view: StaffSigningView }) {
  const items = [
    { key: 'signer', label: t('contractSigning.field.signer'), children: view.signerNameMasked },
    { key: 'phone', label: t('contractSigning.field.phone'), children: view.signerPhoneMasked },
    view.provider !== null && { key: 'provider', label: t('contractSigning.field.provider'), children: providerName(view.provider) },
    (view.status === 'PENDING' || view.status === 'IN_PROGRESS') && {
      key: 'linkExpiresAt',
      label: t('contractSigning.field.linkExpiresAt'),
      children: formatUlaanbaatar(view.linkExpiresAt),
    },
    view.signedAt !== null && { key: 'signedAt', label: t('contractSigning.field.signedAt'), children: formatUlaanbaatar(view.signedAt) },
    view.verificationCode !== null && {
      key: 'verificationCode',
      label: t('contractSigning.field.verificationCode'),
      children: formatVerificationCode(view.verificationCode),
    },
    view.failureReason !== null && { key: 'failureReason', label: t('contractSigning.field.failureReason'), children: failureLabel(view.failureReason) },
  ].filter((item) => item !== false);
  return <Descriptions size="small" column={1} items={items} />;
}
