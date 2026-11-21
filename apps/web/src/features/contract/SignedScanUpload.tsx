'use client';
import { useState } from 'react';
import { UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Typography, Upload, App as AntApp } from 'antd';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatBytes } from '../documents/shared/files';
import { t } from '../../lib/i18n';
import { isSignedScanFile, isSignedScanTypeError, SIGNED_SCAN_ACCEPT } from './signed-scan';

interface Props {
  loading: boolean;
  /** Хавсаргах дуудлагын сүүлийн алдаа (сервер 415 SIGNED_SCAN_TYPE_NOT_ALLOWED гэх мэт). */
  error: unknown;
  /** Хэрэглэгч баталгаажуулсны дараа: DMS-д байршуулж, гэрээнд хавсаргана. Алдааг дуудагч өөрөө харуулдаг тул reject хийхгүй. */
  onConfirmed: (file: File) => Promise<void>;
}

/**
 * F4-13 · Гарын үсэгтэй гэрээний цаасан скан сонгогч. Гэрээг хуулийн дагуу «Гарын үсэг зурагдсан» болгодог тул:
 * (1) зөвхөн PDF/PNG/JPG — төрлийг DMS-д байршуулахаас ӨМНӨ шалгана (буруу файл DMS-д өнчирдөггүй);
 * (2) байршуулахаас өмнө файлын нэр, хэмжээтэй баталгаажуулалт асууна; «Болих» бол юу ч илгээхгүй.
 */
export function SignedScanUpload({ loading, error, onConfirmed }: Props) {
  const { modal } = AntApp.useApp();
  const [rejected, setRejected] = useState(false);

  const confirm = (file: File) =>
    modal.confirm({
      title: t('cstep.confirmTitle'),
      content: (
        <Flex vertical gap={4}>
          <Typography.Text>{t('cstep.confirmBody')}</Typography.Text>
          <Typography.Text strong>{file.name}</Typography.Text>
          <Typography.Text type="secondary">{formatBytes(file.size)}</Typography.Text>
        </Flex>
      ),
      okText: t('cstep.confirmOk'),
      cancelText: t('cstep.confirmCancel'),
      onOk: () => onConfirmed(file),
    });

  return (
    <Flex vertical gap={12}>
      <Upload
        accept={SIGNED_SCAN_ACCEPT}
        showUploadList={false}
        multiple={false}
        disabled={loading}
        beforeUpload={(file) => {
          const allowed = isSignedScanFile(file);
          setRejected(!allowed);
          if (allowed) confirm(file);
          return false; // автомат upload байхгүй
        }}
      >
        <Button icon={<UploadOutlined />} loading={loading}>{t('cstep.upload')}</Button>
      </Upload>
      {rejected ? <Alert type="error" showIcon closable message={t('cstep.scanTypeError')} onClose={() => setRejected(false)} /> : null}
      {isSignedScanTypeError(error) ? <Alert type="error" showIcon message={t('cstep.scanTypeError')} /> : <ApiErrorAlert error={error} />}
    </Flex>
  );
}
