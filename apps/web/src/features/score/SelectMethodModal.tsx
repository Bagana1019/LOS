'use client';
import { useEffect, useState } from 'react';
import { Flex, Input, Modal, Typography } from 'antd';
import type { CalcMethod } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ScoreErrorAlert } from './ScoreErrorAlert';
import { methodKey } from './score.utils';

export const REASON_MAX_LENGTH = 500;

interface Props {
  /** null = хаалттай */
  method: CalcMethod | null;
  loading: boolean;
  error: unknown;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/** FR-8.2: гараар арга солих. Тайлбар заавал биш (Q-M8-8), 500 тэмдэгт хүртэл. */
export function SelectMethodModal({ method, loading, error, onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (method) setReason('');
  }, [method]);
  const name = method ? t(methodKey(method)) : '';
  return (
    <Modal
      open={method !== null}
      title={t('score.select.modal.title', { method: name })}
      okText={t('score.select.confirm')}
      cancelText={t('score.select.cancel')}
      confirmLoading={loading}
      cancelButtonProps={{ disabled: loading }}
      maskClosable={!loading}
      keyboard={!loading}
      destroyOnHidden
      onOk={() => onConfirm(reason.trim())}
      onCancel={() => (loading ? undefined : onCancel())}
    >
      <Flex vertical gap={12}>
        <Typography.Text>{t('score.select.modal.text')}</Typography.Text>
        <label htmlFor="score-select-reason" style={{ fontWeight: 500 }}>{t('score.select.reason.label')}</label>
        <Input.TextArea
          id="score-select-reason"
          value={reason}
          maxLength={REASON_MAX_LENGTH}
          showCount
          autoSize={{ minRows: 2, maxRows: 5 }}
          placeholder={t('score.select.reason.placeholder')}
          onChange={(e) => setReason(e.target.value)}
        />
        {error ? <ScoreErrorAlert error={error} title={t('score.error.selectTitle')} /> : null}
      </Flex>
    </Modal>
  );
}
