'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MeResponse, type AuthResponse, type LoginRequest } from '@los/contracts';
import { apiFetch } from '../api';
import { isStandalonePath } from '../access';
import { endSession, loginRequest, logoutRequest, onSessionEnded, onSessionRefreshed, refreshSession } from './session';

/** booting: cookie-ээр сесс сэргээж байна · unreachable: gateway хариугүй (нэвтрээгүй гэж андуурахгүй). */
export type AuthStatus = 'booting' | 'authenticated' | 'anonymous' | 'unreachable';
/** Нэвтрээгүй болсон шалтгаан: expired = сесс дундаа дууссан, signed_out = хэрэглэгч өөрөө гарсан. */
export type EndReason = 'expired' | 'signed_out' | null;

interface AuthContextValue {
  status: AuthStatus;
  /** `GET /api/auth/me`: хэрэглэгч, эрх, дүрийн цэс. Sidebar зөвхөн үүнийг зурна. */
  me: MeResponse | undefined;
  reason: EndReason;
  login(body: LoginRequest): Promise<void>;
  logout(): Promise<void>;
  retry(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
export const ME_KEY = ['auth', 'me'] as const;
const meOf = ({ user, permissions, menu }: AuthResponse): MeResponse => ({ user, permissions, menu });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const pathname = usePathname();
  const standalone = isStandalonePath(pathname);
  const [status, setStatus] = useState<AuthStatus>(standalone ? 'anonymous' : 'booting');
  const [reason, setReason] = useState<EndReason>(null);

  const boot = useCallback(async () => {
    setStatus('booting');
    try {
      setStatus((await refreshSession()) ? 'authenticated' : 'anonymous');
    } catch {
      setStatus('unreachable');
    }
  }, []);
  useEffect(() => {
    // Staff shell-гүй хуудас (гарын үсгийн холбоос гэх мэт) дээр сесс сэргээхгүй
    if (!standalone) void boot();
  }, [boot, standalone]);

  useEffect(
    () =>
      onSessionEnded(() => {
        qc.clear();
        setReason((r) => r ?? 'expired');
        setStatus('anonymous');
      }),
    [qc],
  );
  // Refresh бүр cache-ийг шинэчилнэ. Cookie браузер даяар нэг тул өөр табд хэрэглэгч солигдсон бол энэ таб өмнөх хэрэглэгчийн
  // нэр, цэс, өгөгдлийг үргэлжлүүлэн үзүүлэх ёсгүй → сесс дууссан гэж үзнэ.
  useEffect(
    () =>
      onSessionRefreshed((s) => {
        const prev = qc.getQueryData<MeResponse>(ME_KEY);
        if (prev && prev.user.id !== s.user.id) endSession();
        else qc.setQueryData(ME_KEY, meOf(s));
      }),
    [qc],
  );

  // Цэс/эрх өөрчлөгдсөнийг таб руу буцахад авна; login/refresh-ийн хариуг cache-д урьдчилан хийсэн (staleTime дотор дахин дуудахгүй).
  const meQuery = useQuery({
    queryKey: ME_KEY,
    queryFn: () => apiFetch('/auth/me', { schema: MeResponse }),
    enabled: status === 'authenticated',
    staleTime: 5 * 60_000,
  });

  const login = useCallback(
    async (body: LoginRequest) => {
      const s = await loginRequest(body);
      qc.setQueryData(ME_KEY, meOf(s));
      setReason(null);
      setStatus('authenticated');
    },
    [qc],
  );
  const logout = useCallback(async () => {
    await logoutRequest();
    qc.clear();
    setReason('signed_out');
    setStatus('anonymous');
  }, [qc]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, me: meQuery.data, reason, login, logout, retry: () => void boot() }),
    [status, meQuery.data, reason, login, logout, boot],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
