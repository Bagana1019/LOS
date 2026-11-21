'use client';
import { useState } from 'react';
import { App as AntApp, Button, Flex, Typography, Upload } from 'antd';
import { t } from '../../lib/i18n';
import { uploadDmsFile } from '../documents/shared/files';
import { PHOTO_ACCEPT, PHOTO_MAX_MB, validatePhotoFile, type PhotoRejectReason } from './customer-photo';

const { Text } = Typography;

const REJECT_KEY: Record<PhotoRejectReason, string> = {
  EMPTY: 'customer.new.photoReject.empty',
  TYPE: 'customer.new.photoReject.type',
  TOO_LARGE: 'customer.new.photoReject.size',
};

interface Props {
  /** Одоогийн `photoFileId` (маягтын утга). Засах горимд өмнө нь орсон зураг нэргүй ирнэ. */
  photoId: string | undefined;
  onChange: (id: string | undefined) => void;
}

/**
 * F1-12: ИҮ-ийн зураг оруулах. Файлыг илгээхээс ӨМНӨ шалгана (төрөл / хэмжээ / хоосон) — татгалзсан бол message.error + маягтын доор үлдэх мөр
 * (toast 3 секундэд алга болдог тул). Орсон файлын нэр ба «Устгах» товч харагдана.
 */
export function CustomerPhotoUpload({ photoId, onChange }: Props) {
  const { message } = AntApp.useApp();
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const reject = (text: string) => { setRejected(text); void message.error(text); };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const saved = await uploadDmsFile(file);
      setFileName(file.name);
      onChange(saved.id);
      void message.success(t('customer.new.photoUploaded'));
    } catch {
      reject(t('customer.new.photoFailed'));
    } finally {
      setUploading(false);
    }
  };

  const beforeUpload = (file: File) => {
    setRejected(null);
    const reason = validatePhotoFile(file);
    if (reason) { reject(t(REJECT_KEY[reason], { name: file.name, max: PHOTO_MAX_MB })); return Upload.LIST_IGNORE; }
    void upload(file);
    return false;
  };

  const remove = () => { setFileName(null); setRejected(null); onChange(undefined); };

  return (
    <div>
      <Flex gap={8} align="center" wrap>
        <Upload accept={PHOTO_ACCEPT} showUploadList={false} beforeUpload={beforeUpload} maxCount={1}>
          <Button loading={uploading} data-testid="customer-photo-upload">{photoId ? t('customer.new.photoUploaded') : t('customer.new.photoUpload')}</Button>
        </Upload>
        {photoId && fileName ? <Text data-testid="customer-photo-name">{fileName}</Text> : null}
        {photoId ? <Button type="link" size="small" danger data-testid="customer-photo-remove" onClick={remove}>{t('customer.new.photoRemove')}</Button> : null}
      </Flex>
      {rejected ? <div><Text type="danger" data-testid="customer-photo-error">{rejected}</Text></div> : null}
    </div>
  );
}
