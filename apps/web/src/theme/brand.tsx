import { useId, type CSSProperties } from 'react';
import type { ThemeConfig } from 'antd';

/**
 * БРЭНД — нэг газар. Эх сурвалж: "Lignum LOS брэндбүүк" v1.0 (2026).
 * Өнгө, фонт, радиус, нэр, лого — бүгд энд. Солих бол ЗӨВХӨН энэ файлыг засна;
 * CSS нь `brandCssVars` (--brand-*) хувьсагчаар, antd нь `antdTheme`-ээр, merchant нь `merchantTheme`-ээр уншина.
 */
export const brand = {
  /** Брэндбүүк: бичлэг үргэлж "Lignum LOS" ("LIGNUM", "Lignum-LOS" биш). */
  name: 'Lignum LOS',
  wordmark: 'Lignum',
  sub: 'LOS',
  colors: {
    forest: '#0A3A2A', // brand-forest: sidebar, толгой, гарчиг, лого
    forestMuted: '#2F6B57', // brand-forest-muted: дэд гарчиг, шошго, цайвар дэвсгэр дээрх "LOS"
    mint: '#10B981', // brand-mint: үндсэн үйлдэл, идэвхтэй төлөв. Цагаан дээр ТЕКСТ болгохгүй (2.6:1)
    mintStrong: '#059669', // brand-mint-strong: hover, фокус
    onMint: '#042F22', // минт дэвсгэр дээрх текст
    surface0: '#F8FAFC', // хуудасны дэвсгэр
    surface1: '#FFFFFF', // карт, толгой
    ink: '#0F172A', // үндсэн текст
    inkMuted: '#475569', // хоёрдогч текст (neutral badge-ийн текстээс)
    border: '#E2E8F0', // 1px хүрээ (брэндбүүкт тусгай HEX байхгүй — slate-200; docs/DECISIONS.md)
  },
  /** Зээлийн хүсэлтийн төлвийн badge (брэндбүүк §07): дэвсгэр / текст / хүрээ. */
  status: {
    success: { bg: '#D1FAE5', fg: '#065F46' },
    progress: { bg: '#ECFDF5', fg: '#065F46', border: '#059669' },
    info: { bg: '#EFF6FF', fg: '#1D4ED8' },
    warning: { bg: '#FEF3C7', fg: '#92400E' },
    danger: { bg: '#FEE2E2', fg: '#B91C1C' },
    neutral: { bg: '#F1F5F9', fg: '#475569' },
  },
  /** Скор: 700+ ногоон, 600–699 шар, <600 улаан (тоог үргэлж бичнэ). */
  score: { good: '#059669', mid: '#B45309', low: '#B91C1C' },
  /** Радиус: товч/input 10, карт 14, badge pill. */
  radius: { control: 10, card: 14, pill: 999 },
  /** Үсгийн хэв: Manrope — гарчиг, тоо; Inter — интерфейс. Хоёулаа Кирилл Ө, Ү-тэй. */
  fonts: {
    display: "'Manrope Variable', 'Manrope', 'Inter Variable', 'Inter', system-ui, sans-serif",
    body: "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif",
  },
} as const;

/** CSS хувьсагчууд — `<html style>` дээр тавина (portal-оор body-д гарах antd Drawer/Modal ч уншина). */
export const brandCssVars = {
  '--brand-forest': brand.colors.forest,
  '--brand-forest-muted': brand.colors.forestMuted,
  '--brand-mint': brand.colors.mint,
  '--brand-mint-strong': brand.colors.mintStrong,
  '--brand-on-mint': brand.colors.onMint,
  '--brand-surface-0': brand.colors.surface0,
  '--brand-surface-1': brand.colors.surface1,
  '--brand-ink': brand.colors.ink,
  '--brand-ink-muted': brand.colors.inkMuted,
  '--brand-border': brand.colors.border,
  '--brand-radius-control': `${brand.radius.control}px`,
  '--brand-radius-card': `${brand.radius.card}px`,
  '--brand-font-display': brand.fonts.display,
  '--brand-font-body': brand.fonts.body,
} as CSSProperties;

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: brand.colors.mint,
    colorPrimaryHover: brand.colors.mintStrong,
    colorLink: brand.colors.forestMuted, // минт цагаан дээр текстээр хэрэглэхгүй
    colorLinkHover: brand.colors.mintStrong,
    colorSuccess: brand.colors.mintStrong,
    colorWarning: brand.status.warning.fg,
    colorError: brand.status.danger.fg,
    colorInfo: brand.status.info.fg,
    colorTextBase: brand.colors.ink,
    colorBgLayout: brand.colors.surface0,
    colorBgContainer: brand.colors.surface1,
    colorBorder: brand.colors.border,
    colorBorderSecondary: brand.colors.border,
    controlOutline: 'rgba(16, 185, 129, 0.35)', // фокусын минт хүрээ
    borderRadius: brand.radius.control,
    borderRadiusLG: brand.radius.card,
    controlHeight: 40, // товч ≥ 40px
    fontFamily: brand.fonts.body,
    boxShadow: 'none', // хүрээ, сүүдэр биш — сүүдэр зөвхөн popover-т
    boxShadowSecondary: '0 6px 16px rgba(15, 23, 42, 0.12)',
  },
  components: {
    Layout: { siderBg: brand.colors.forest, headerBg: brand.colors.surface1, bodyBg: brand.colors.surface0, headerPadding: '0 20px' },
    Menu: {
      darkItemBg: brand.colors.forest,
      darkSubMenuItemBg: brand.colors.forest,
      darkItemSelectedBg: brand.colors.mint,
      darkItemSelectedColor: brand.colors.onMint,
      darkItemHoverBg: 'rgba(255, 255, 255, 0.08)',
    },
    Button: { primaryColor: brand.colors.onMint, fontWeight: 600, primaryShadow: 'none' },
    Card: { headerFontSize: 16 },
    Table: { headerBg: brand.colors.surface0, headerColor: brand.colors.forestMuted, borderColor: brand.colors.border },
    Typography: { titleMarginBottom: '0.5em' },
  },
};

type MarkVariant = 'color' | 'reversed' | 'mono';
const MARK_COLORS: Record<MarkVariant, [string, string]> = {
  color: [brand.colors.forest, brand.colors.mint],
  reversed: ['#FFFFFF', brand.colors.mint],
  mono: [brand.colors.forest, brand.colors.forest],
};

/** Брэндийн жинхэнэ SVG файлууд (`public/brand/`, брэндбүүк v1.0). Wordmark нь path болсон тул фонт шаардахгүй. Солих бол зөвхөн энд. */
export const brandAssets = {
  lockup: '/brand/lignum-lockup.svg', // цайвар дэвсгэр, viewBox 590×180
  lockupReversed: '/brand/lignum-lockup-reversed.svg', // ойн ногоон дэвсгэр
  stacked: '/brand/lignum-stacked.svg', // нэвтрэх, том гарчиг, viewBox 420×300
} as const;
const LOCKUP_RATIO = 590 / 180;
const STACKED_RATIO = 420 / 300;

/**
 * Тэмдэг (нарийссан sidebar, жижиг зай): хоёр нэхэгдсэн цагираг. `lignum-lockup.svg`-ийн тэмдгийн яг ижил геометр (mask-тай).
 * Хамгаалалтын талбай ⅓-ийг тооцсон viewBox.
 */
export function BrandMark({ size = 32, variant = 'color', title }: { size?: number; variant?: MarkVariant; title?: string }) {
  const [a, b] = MARK_COLORS[variant];
  const uid = useId().replace(/:/g, '');
  return (
    <svg width={size * (104 / 80)} height={size} viewBox="0 0 104 80" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} focusable="false" style={{ flex: 'none', display: 'block' }}>
      <defs>
        <mask id={`${uid}r`} maskUnits="userSpaceOnUse" x="0" y="0" width="104" height="80">
          <rect width="104" height="80" fill="#fff" />
          <path d="M10 40 A26 26 0 0 1 62 40" fill="none" stroke="#000" strokeWidth="21" />
        </mask>
        <mask id={`${uid}l`} maskUnits="userSpaceOnUse" x="0" y="0" width="104" height="80">
          <rect width="104" height="80" fill="#fff" />
          <path d="M42 40 A26 26 0 0 0 94 40" fill="none" stroke="#000" strokeWidth="21" />
        </mask>
      </defs>
      <circle cx="36" cy="40" r="26" fill="none" stroke={a} strokeWidth="13" mask={`url(#${uid}l)`} />
      <circle cx="68" cy="40" r="26" fill="none" stroke={b} strokeWidth="13" mask={`url(#${uid}r)`} />
    </svg>
  );
}

/** Хуучин нэр хэвээр — тэмдэг. */
export function BrandLogo({ size = 32, variant = 'color' }: { size?: number; variant?: MarkVariant }) {
  return <BrandMark size={size} variant={variant} />;
}

/** Хэвтээ лого (жинхэнэ SVG). `height` — px; `onDark` — ойн ногоон дэвсгэр дээр reversed хувилбар. Брэндбүүк: хамгийн бага өргөн 120px. */
export function BrandLockup({ height = 40, onDark = false, className }: { height?: number; onDark?: boolean; className?: string }) {
  return <img src={onDark ? brandAssets.lockupReversed : brandAssets.lockup} alt={brand.name} width={Math.round(height * LOCKUP_RATIO)} height={height} className={className} style={{ display: 'block', flex: 'none' }} />;
}

/** Босоо (stacked) лого — нэвтрэх хуудас гэх мэт. */
export function BrandStacked({ width = 200, className }: { width?: number; className?: string }) {
  return <img src={brandAssets.stacked} alt={brand.name} width={width} height={Math.round(width / STACKED_RATIO)} className={className} style={{ display: 'block', margin: '0 auto', maxWidth: '100%', height: 'auto' }} />;
}
