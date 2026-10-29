import type { ThemeConfig } from 'antd';
// Сүр багатай, мэргэжлийн сэдэв. Өнгөнүүд merchant.css-ийн --mp-* хувьсагчтай нэг утгатай байх ёстой.

export const MP_COLORS = { primary: '#0b63ce', navy: '#0f1f3d', bg: '#f4f6fa', border: '#e3e8ef', text: '#1a2433', muted: '#5b6778', success: '#0f7a55', warning: '#a96400', danger: '#c0342b', series2: '#0f7a55' } as const;

export const merchantTheme: ThemeConfig = {
  token: {
    colorPrimary: MP_COLORS.primary,
    colorSuccess: MP_COLORS.success,
    colorWarning: MP_COLORS.warning,
    colorError: MP_COLORS.danger,
    colorTextBase: MP_COLORS.text,
    colorTextSecondary: MP_COLORS.muted,
    colorBgLayout: MP_COLORS.bg,
    colorBorderSecondary: MP_COLORS.border,
    borderRadius: 8,
    borderRadiusLG: 12,
    controlHeight: 40,
    controlHeightLG: 52,
    fontSize: 14,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "DejaVu Sans", sans-serif',
  },
  components: {
    Table: { headerBg: '#f7f9fc', headerColor: MP_COLORS.muted, rowHoverBg: '#f2f6fc' },
    Card: { headerFontSize: 15 },
    Button: { fontWeight: 600 },
  },
};
