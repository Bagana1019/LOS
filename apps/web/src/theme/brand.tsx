import type { ThemeConfig } from 'antd';

/**
 * БРЭНД — нэг газар. Брэндбүүк ирээгүй тул Ant Design-ийн үндсэн өнгө, түр лого ("L").
 * Брэндбүүк ирмэгц ЗӨВХӨН энэ файлыг солино: өнгө, нэр, лого.
 */
export const brand = {
  name: 'LOS Radix',
  colors: {
    primary: '#1677ff',
    siderBg: '#001529',
    headerBg: '#ffffff',
    contentBg: '#f5f5f5',
  },
} as const;

export const antdTheme: ThemeConfig = {
  token: { colorPrimary: brand.colors.primary, borderRadius: 6 },
  components: {
    Layout: { siderBg: brand.colors.siderBg, headerBg: brand.colors.headerBg, bodyBg: brand.colors.contentBg, headerPadding: '0 20px' },
    Menu: { darkItemBg: brand.colors.siderBg },
  },
};

/** Түр лого: брэнд өнгөтэй дөрвөлжин дотор нэрийн эхний үсэг. Жинхэнэ лого ирвэл `<img>`/SVG-ээр солино. */
export function BrandLogo({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 5),
        background: brand.colors.primary,
        color: '#fff',
        display: 'inline-grid',
        placeItems: 'center',
        fontWeight: 700,
        fontSize: Math.round(size * 0.5),
        flex: 'none',
      }}
    >
      {brand.name.charAt(0)}
    </span>
  );
}
