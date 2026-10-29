'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AutoComplete, Input, Space, Typography } from 'antd';
import type { RefSelectProps } from 'antd/es/select';
import { SearchOutlined } from '@ant-design/icons';
import type { MeResponse } from '@los/contracts';
import { t } from '@los/ui';
import { contractSearchHref, looksLikeContractNo, searchMenu } from '../../lib/access';
import { menuIcon } from './menu-icons';

const CONTRACT = 'contract:';
interface Opt { value: string; label: string; icon: ReactNode }
interface Group { label: string; options: Opt[] }

/** FR-1.4 Нэгдсэн хайлт: цэс болон гэрээний дугаар. Гэрээний хайлт жагсаалтын `?q=` руу шилжинэ (жагсаалтыг M2 хэрэгжүүлнэ). */
export function HeaderSearch({ me }: { me: MeResponse }) {
  const router = useRouter();
  // ref нь AutoComplete дээр: хүүхэд <Input ref> нь rc-select-ийн `element.ref` уншилтаар React 19-ийн анхааруулга (dev) өгдөг
  const select = useRef<RefSelectProps>(null);
  const [q, setQ] = useState('');
  const canSearchContracts = me.permissions.includes('application:read');

  // `/` дарахад хайлтад фокус (текст оруулж байхад биш).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        select.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const options = useMemo<Group[]>(() => {
    const menuHits = searchMenu(q, me.menu, (i) => t(i.labelKey));
    const menuGroup = menuHits.length
      ? [{ label: t('shell.search.menu'), options: menuHits.map((i) => ({ value: i.href, label: t(i.labelKey), icon: menuIcon(i.id) })) }]
      : [];
    const text = q.trim();
    const contractGroup =
      canSearchContracts && text
        ? [{ label: t('shell.search.contract'), options: [{ value: `${CONTRACT}${text}`, label: t('shell.search.contract_option', { q: text }), icon: <SearchOutlined aria-hidden /> }] }]
        : [];
    // Тоотой хайлт = гэрээний дугаар: Enter эхний сонголтыг авдаг тул гэрээний бүлгийг урд тавина.
    return looksLikeContractNo(text) ? [...contractGroup, ...menuGroup] : [...menuGroup, ...contractGroup];
  }, [q, me.menu, canSearchContracts]);

  const go = (value: string) => {
    router.push(value.startsWith(CONTRACT) ? contractSearchHref(value.slice(CONTRACT.length)) : value);
    setQ('');
    select.current?.blur();
  };

  return (
    // Сонголтын `label` нь string (screen reader үүнийг уншдаг); дүрсийг зөвхөн харагдах хэсэгт optionRender-ээр нэмнэ.
    <AutoComplete
      ref={select}
      value={q}
      options={options}
      optionRender={(o) => (
        <Space size={8}>
          {(o.data as unknown as Opt).icon}
          {o.label}
        </Space>
      )}
      // combobox горимд эхний сонголт өөрөө идэвхжихгүй: Enter-ээр шууд очихын тулд асаана (хоосон хайлтад биш — санамсаргүй шилжилтээс сэргийлнэ)
      defaultActiveFirstOption={q.trim() !== ''}
      onChange={setQ}
      onSelect={go}
      style={{ flex: 1, maxWidth: 440, minWidth: 0 }}
      popupMatchSelectWidth
    >
      <Input
        allowClear
        prefix={<SearchOutlined />}
        suffix={<Typography.Text className="los-kbd-hint" keyboard type="secondary" aria-hidden>/</Typography.Text>}
        placeholder={t('shell.search.placeholder')}
        aria-label={t('shell.search.label')}
        // rc-select Tab-ыг Enter шиг эхний сонголт болгож шилжүүлдэг — гарнаас фокус зөөхөд хуудас солигдохгүй байхын тулд хаана
        onKeyDown={(e) => {
          if (e.key === 'Tab') e.stopPropagation();
        }}
      />
    </AutoComplete>
  );
}
