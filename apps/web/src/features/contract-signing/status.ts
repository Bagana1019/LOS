import type { SigningStatus } from '@los/contracts';
import type { StaffSigningView } from './api';

// FR-11.4 — ажилтны самбарын төлвийн логик (цэвэр функц).

export type PanelStatus = SigningStatus | 'NONE';

export function panelStatus(view: StaffSigningView | null): PanelStatus {
  return view === null ? 'NONE' : view.status;
}

export interface PanelActions {
  /** Шинэ хүсэлт үүсгэх (хүсэлт байхгүй эсвэл өмнөх нь дууссан/амжилтгүй) */
  send: boolean;
  /** Идэвхтэй хүсэлтийн линкийг шинэчилж SMS дахин илгээх */
  resend: boolean;
  cancel: boolean;
}

/**
 * dms-ийн төлвийн машин: идэвхтэй (PENDING | IN_PROGRESS) үед л resend/cancel; FINALIZING түр түгжээ (цуцлах боломжгүй);
 * SIGNED дээр юу ч хийхгүй; хүсэлт байхгүй/төгссөн (татгалзсан, хугацаа дууссан, амжилтгүй, цуцалсан) үед шинээр илгээнэ.
 */
export function availableActions(status: PanelStatus): PanelActions {
  switch (status) {
    case 'PENDING':
    case 'IN_PROGRESS':
      return { send: false, resend: true, cancel: true };
    case 'FINALIZING':
    case 'SIGNED':
      return { send: false, resend: false, cancel: false };
    case 'NONE':
    case 'DECLINED':
    case 'EXPIRED':
    case 'FAILED':
    case 'CANCELLED':
      return { send: true, resend: false, cancel: false };
  }
}

/** Идэвхтэй (дуусаагүй) хүсэлт — самбар төлвийг үе үе шинэчилнэ */
export function isActive(status: PanelStatus): boolean {
  return status === 'PENDING' || status === 'IN_PROGRESS' || status === 'FINALIZING';
}

export type TagColor = 'default' | 'processing' | 'success' | 'error' | 'warning';

export const STATUS_COLOR: Readonly<Record<PanelStatus, TagColor>> = {
  NONE: 'default',
  PENDING: 'processing',
  IN_PROGRESS: 'processing',
  FINALIZING: 'processing',
  SIGNED: 'success',
  DECLINED: 'error',
  EXPIRED: 'warning',
  FAILED: 'error',
  CANCELLED: 'default',
};
