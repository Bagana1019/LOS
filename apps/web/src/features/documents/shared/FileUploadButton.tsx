'use client';
import { UploadOutlined } from '@ant-design/icons';
import { Button, Upload } from 'antd';
import { DMS_ACCEPT } from './files';

interface Props {
  label: string;
  /** Дэлгэцийн уншигчид: аль мөр/баримтад хамаарахыг заана. */
  ariaLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  type?: 'default' | 'primary' | 'link';
  size?: 'small' | 'middle';
  onFile: (file: File) => void;
}

/** Файл сонгох товч (antd Upload, автомат upload-гүй): сонгосон файлыг `onFile`-д өгнө. */
export function FileUploadButton({ label, ariaLabel, loading, disabled, type = 'default', size = 'middle', onFile }: Props) {
  return (
    <Upload
      accept={DMS_ACCEPT}
      showUploadList={false}
      multiple={false}
      disabled={disabled || loading}
      beforeUpload={(file) => {
        onFile(file);
        return false;
      }}
    >
      <Button icon={<UploadOutlined />} type={type} size={size} loading={loading} disabled={disabled} aria-label={ariaLabel ?? label}>
        {label}
      </Button>
    </Upload>
  );
}
