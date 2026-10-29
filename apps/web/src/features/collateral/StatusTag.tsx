import { Tag } from 'antd';
import { t } from '../../lib/i18n';
import type { Tone } from './collateral.utils';

const COLOR: Record<Tone, string | undefined> = { success: 'success', warning: 'warning', error: 'error', default: undefined };

interface Props {
  tone: Tone;
  /** Харагдах нэр, жишээ нь «Өмчлөл»; өгвөл «Өмчлөл: Баталгаажсан» гэж харуулна (өнгөнөөс гадна текстээр ялгагдана). */
  label?: string;
  textKey: string;
  params?: Record<string, string | number>;
}

/** Төлөвийн шошго: өнгө ганцаараа утга илэрхийлэхгүй — төлөв үргэлж текстээр. */
export function StatusTag({ tone, label, textKey, params }: Props) {
  const text = t(textKey, params);
  return <Tag color={COLOR[tone]} style={{ marginInlineEnd: 0 }}>{label ? `${label}: ${text}` : text}</Tag>;
}
