import type { CSSProperties } from 'react';

// Гар утасны (360–430 px) нэг багана; хэвтээ scroll байхгүй — урт текст/хэшийг таслана.
export const GLOBAL_CSS =
  "html{-webkit-text-size-adjust:100%}body{margin:0;background:#f5f7fa;color:rgba(0,0,0,0.88);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif}";

export const page: CSSProperties = { minHeight: '100dvh', boxSizing: 'border-box', padding: '16px', background: '#f5f7fa' };
export const column: CSSProperties = { maxWidth: 480, width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 };
export const card: CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  padding: 16,
  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  overflowWrap: 'anywhere',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};
export const heading: CSSProperties = { margin: 0, fontSize: 20, lineHeight: 1.3, fontWeight: 600 };
export const muted: CSSProperties = { margin: 0, color: 'rgba(0,0,0,0.65)', fontSize: 15, lineHeight: 1.5 };
export const mono: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere', wordBreak: 'break-all' };
/** Том товч — хурууны хүрэх хэмжээ ≥ 48 px */
export const tap: CSSProperties = { height: 52, fontSize: 17, whiteSpace: 'normal' };
