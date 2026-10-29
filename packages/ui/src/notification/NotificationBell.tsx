'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Empty, Popover, Skeleton, Typography, theme } from 'antd';
import { mn } from '../i18n/mn';

// FR-13.2: мэдэгдлийн хонх — presentational. Өгөгдөл татах, уншсан болгох, чиглүүлэх нь apps/web-ийн NotificationBellContainer-д.

export interface NotificationBellItem {
  id: string;
  title: string;
  body: string;
  /** "5 минутын өмнө" гэх мэт бэлэн текст (цаг хэмжих нь хэрэглэгч талд). */
  timeLabel: string;
  read: boolean;
}

export interface NotificationBellProps {
  items: readonly NotificationBellItem[];
  unreadCount: number;
  /** Жагсаалтыг ачаалж байна (хонхны тоо харагдсаар байна). */
  loading?: boolean;
  /** Жагсаалтыг ачаалж чадсангүй. */
  error?: boolean;
  /** "Бүгдийг уншсан" үйлдэл явагдаж байна. */
  markingAll?: boolean;
  onItemClick: (item: NotificationBellItem) => void;
  onMarkAllRead: () => void;
  onViewAll: () => void;
  onRetry?: () => void;
  /** Нээгдэх/хаагдахад — хэрэглэгч талд жагсаалтыг зөвхөн нээгдэхэд татахад ашиглана. */
  onOpenChange?: (open: boolean) => void;
}

const tr = (key: string, params?: Record<string, string | number>): string => {
  const raw = mn[key] ?? key;
  return params ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : raw;
};

const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 } as const;

/** Гадаад сан (icon сан) нэмэхгүйн тулд inline SVG. */
function BellIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

/** Нээгдсэн цэсний агуулга (гарчиг, "Бүгдийг уншсан", жагсаалт, "Бүгдийг харах"). */
export function NotificationBellPanel({ items, unreadCount, loading = false, error = false, markingAll = false, onItemClick, onMarkAllRead, onViewAll, onRetry }: Omit<NotificationBellProps, 'onOpenChange'>) {
  const { token } = theme.useToken();
  return (
    <div style={{ width: 360 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0 8px' }}>
        <Typography.Text strong>{tr('notification.bell.title')}</Typography.Text>
        <Button type="link" size="small" disabled={unreadCount === 0 || markingAll} loading={markingAll} onClick={onMarkAllRead}>
          {tr('notification.bell.markAllRead')}
        </Button>
      </div>

      <div style={{ maxHeight: 400, overflowY: 'auto', borderTop: `1px solid ${token.colorBorderSecondary}` }}>
        {error ? (
          <Alert
            style={{ margin: '8px 0' }}
            type="error"
            showIcon
            message={tr('notification.bell.error')}
            action={onRetry ? <Button size="small" onClick={onRetry}>{tr('notification.common.retry')}</Button> : undefined}
          />
        ) : loading && items.length === 0 ? (
          <div style={{ padding: '12px 0' }}><Skeleton active title={false} paragraph={{ rows: 4 }} /></div>
        ) : items.length === 0 ? (
          <Empty style={{ margin: '24px 0' }} image={Empty.PRESENTED_IMAGE_SIMPLE} description={tr('notification.bell.empty')} />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((item) => (
              <li key={item.id} style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
                <button
                  type="button"
                  onClick={() => onItemClick(item)}
                  style={{ display: 'flex', gap: 10, width: '100%', padding: '10px 4px', background: 'transparent', border: 0, textAlign: 'left', cursor: 'pointer', color: token.colorText, font: 'inherit' }}
                >
                  <span
                    aria-hidden="true"
                    style={{ flex: '0 0 auto', width: 8, height: 8, marginTop: 7, borderRadius: '50%', background: item.read ? 'transparent' : token.colorPrimary }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: item.read ? 400 : 600 }}>
                      {item.read ? null : <span style={VISUALLY_HIDDEN}>{tr('notification.bell.unreadItem')}: </span>}
                      {item.title}
                    </span>
                    <span
                      style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
                    >
                      {item.body}
                    </span>
                    <span style={{ display: 'block', color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 2 }}>{item.timeLabel}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ textAlign: 'center', paddingTop: 8 }}>
        <Button type="link" onClick={onViewAll}>{tr('notification.bell.viewAll')}</Button>
      </div>
    </div>
  );
}

export function NotificationBell({ onOpenChange, onItemClick, onViewAll, ...panel }: NotificationBellProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);

  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Popover
      content={
        <NotificationBellPanel
          {...panel}
          onItemClick={(item) => {
            change(false);
            onItemClick(item);
          }}
          onViewAll={() => {
            change(false);
            onViewAll();
          }}
        />
      }
      trigger="click"
      placement="bottomRight"
      arrow={false}
      open={open}
      onOpenChange={change}
      styles={{ body: { padding: 12 } }}
    >
      <Button
        type="text"
        shape="circle"
        aria-label={panel.unreadCount > 0 ? tr('notification.bell.ariaLabelUnread', { count: panel.unreadCount }) : tr('notification.bell.ariaLabel')}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Badge count={panel.unreadCount} overflowCount={99} size="small" offset={[2, -2]}>
          <span style={{ display: 'inline-flex', color: token.colorTextSecondary }}><BellIcon /></span>
        </Badge>
      </Button>
    </Popover>
  );
}
