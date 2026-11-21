'use client';
import { UploadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Upload } from 'antd';
import { t } from '../../../lib/i18n';
import { DMS_ACCEPT, formatBytes } from './files';

/** dms-ийн дээд хэмжээ: apps/dms/src/modules/file/file.service.ts `DEFAULT_MAX_BYTES` (`FILE_MAX_BYTES`-ийн анхдагч; docs/DECISIONS.md 2026-10-28). Эцсийн шалгалт сервер дээр. */
export const DMS_MAX_BYTES = 20 * 1024 * 1024;

/** Зөвшөөрөгдөх өргөтгөлүүд нь `<input accept>`-тай ижил ГАНЦ эх сурвалжаас (files.ts `DMS_ACCEPT`) уламжлагдана. */
const ALLOWED_EXTENSIONS: readonly string[] = DMS_ACCEPT.split(',').map((ext) => ext.slice(1));

/** «PDF, PNG, JPG, …» — алдааны мессеж ба тайлбарт харуулна. */
export const DMS_TYPES_LABEL = ALLOWED_EXTENSIONS.map((ext) => ext.toUpperCase()).join(', ');

const REJECTION_TOAST_SECONDS = 6;

type Rejection = 'type' | 'empty' | 'size';

/** dms-тэй ижил: эхний цэгүүдийг хасаад сүүлийн цэгийн дараахыг авна (`.pdf`, `README`, `a.pdf.` нь өргөтгөлгүй). */
function extensionOf(name: string): string {
  const base = name.replace(/^\.+/, '');
  return base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
}

/** Төрөл эхэлж шалгагдана: буруу төрлийн файлыг засахад хоосон/том эсэх нь хамаагүй. */
function rejectionOf(file: Pick<File, 'name' | 'size'>): Rejection | null {
  if (!ALLOWED_EXTENSIONS.includes(extensionOf(file.name))) return 'type';
  if (file.size === 0) return 'empty';
  if (file.size > DMS_MAX_BYTES) return 'size'; // яг хязгаар зөвшөөрөгдөнө (dms зөвхөн хэтэрснийг татгалзана)
  return null;
}

/** Файлыг татгалзах шалтгаан (файлын нэр + зөвшөөрөгдөх төрөл + дээд хэмжээтэй мессеж); зөвшөөрөгдвөл `null`. */
export function fileRejectionMessage(file: Pick<File, 'name' | 'size'>): string | null {
  const reason = rejectionOf(file);
  if (!reason) return null;
  const limits = t('document.upload.limits', { types: DMS_TYPES_LABEL, max: formatBytes(DMS_MAX_BYTES) });
  return `${t(`document.upload.reject.${reason}`, { name: file.name })} ${limits}`;
}

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

/**
 * Файл сонгох товч (antd Upload, автомат upload-гүй): зөвхөн шалгалтад тэнцсэн файлыг `onFile`-д өгнө.
 * Буруу (төрөл, хоосон, хэт том) файлыг хүсэлтгүйгээр татгалзаж, шалтгааныг `message.error`-оор хэлнэ (F4-12).
 */
export function FileUploadButton({ label, ariaLabel, loading, disabled, type = 'default', size = 'middle', onFile }: Props) {
  const { message } = AntApp.useApp();
  return (
    <Upload
      accept={DMS_ACCEPT}
      showUploadList={false}
      multiple={false}
      disabled={disabled || loading}
      beforeUpload={(file) => {
        const rejection = fileRejectionMessage(file);
        if (rejection) {
          void message.error({ content: rejection, duration: REJECTION_TOAST_SECONDS });
          return Upload.LIST_IGNORE;
        }
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
