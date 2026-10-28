import type { ReactNode } from 'react';
import { AppstoreOutlined, BankOutlined, BarChartOutlined, FileTextOutlined, HomeOutlined, SettingOutlined, StopOutlined, UserOutlined } from '@ant-design/icons';

// Цэсний `id` (contracts MENU) → дүрс. contracts-д дүрс байхгүй (UI-ийн асуудал). Шинэ цэс нэмэхэд энд мөр нэм; байхгүй бол ерөнхий дүрс.
// Дүрс нь чимэглэл (текст нь нэрийг өгдөг) тул `aria-hidden` — эс бөгөөс screen reader "bar-chart Тайлан" гэж уншина.
const ICONS: Record<string, ReactNode> = {
  home: <HomeOutlined aria-hidden />,
  customer: <UserOutlined aria-hidden />,
  application: <FileTextOutlined aria-hidden />,
  blacklist: <StopOutlined aria-hidden />,
  loan: <BankOutlined aria-hidden />,
  report: <BarChartOutlined aria-hidden />,
  settings: <SettingOutlined aria-hidden />,
};
export const menuIcon = (id: string): ReactNode => ICONS[id] ?? <AppstoreOutlined aria-hidden />;
