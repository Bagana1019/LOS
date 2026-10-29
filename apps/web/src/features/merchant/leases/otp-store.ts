'use client';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { OtpSent } from '@los/contracts';
import type { PosOtpPurpose } from '@los/contracts';
// Сүүлд илгээсэн OTP-ийн мэдээлэл (утасны маск, дахин илгээх хугацаа). Код өөрөө хэзээ ч ирэхгүй (docs/05 §13). Query cache + sessionStorage (дахин ачаалахад тоологч хадгалагдана).

export const otpKey = (leaseId: string, purpose: PosOtpPurpose) => ['merchant', 'otp', leaseId, purpose] as const;
const storageKey = (leaseId: string, purpose: PosOtpPurpose) => `mp.otp.${leaseId}.${purpose}`;

function readSession(leaseId: string, purpose: PosOtpPurpose): OtpSent | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(leaseId, purpose));
    if (!raw) return null;
    const parsed = OtpSent.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function storeOtp(qc: QueryClient, leaseId: string, otp: OtpSent): void {
  qc.setQueryData(otpKey(leaseId, otp.purpose), otp);
  try {
    window.sessionStorage.setItem(storageKey(leaseId, otp.purpose), JSON.stringify(otp));
  } catch {
    /* sessionStorage боломжгүй (private mode) — зүгээр */
  }
}

export function useStoredOtp(leaseId: string, purpose: PosOtpPurpose): OtpSent | null {
  const q = useQuery<OtpSent | null>({
    queryKey: otpKey(leaseId, purpose),
    queryFn: async () => readSession(leaseId, purpose),
    initialData: () => readSession(leaseId, purpose),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    enabled: false,
  });
  return q.data ?? null;
}
