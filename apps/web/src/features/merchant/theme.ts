import type { ThemeConfig } from 'antd';
import { brand } from '../../theme/brand';
// Сүр багатай, мэргэжлийн сэдэв. Өнгөнүүд merchant.css-ийн --mp-* хувьсагчтай нэг утгатай байх ёстой.

export const MP_COLORS = { primary: brand.colors.forestMuted, navy: brand.colors.forest, bg: brand.colors.surface0, border: brand.colors.border, text: brand.colors.ink, muted: brand.colors.inkMuted, success: brand.status.success.fg, warning: brand.status.warning.fg, danger: brand.status.danger.fg, series2: brand.colors.mint } as const;

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
    borderRadius: brand.radius.control,
    borderRadiusLG: brand.radius.card,
    controlHeight: 40,
    controlHeightLG: 52,
    fontSize: 14,
    fontFamily: brand.fonts.body,
  },
  components: {
    Table: { headerBg: brand.colors.surface0, headerColor: brand.colors.forestMuted, rowHoverBg: '#f1f8f5' },
    Card: { headerFontSize: 15 },
    Button: { fontWeight: 600, primaryColor: '#ffffff' },
  },
};
