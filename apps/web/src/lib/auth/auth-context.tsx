'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MeResponse, type AuthResponse, type LoginRequest } from '@los/contracts';
import { apiFetch } from '../api';
import { loginRequest, logoutRequest, onSessionEnded, refreshSession } from './session';

/** booting: cookie-ээр сесс сэргээж байна · unreachable: gateway хариугүй (нэвтрээгүй гэж андуурахгүй). */
export type AuthStatus = 'booting' | 'authenticated' | 'anonymous' | 'unreachable';

interface AuthContextValue {
  status: AuthStatus;
  /** `GET /api/auth/me`: хэрэглэгч, эрх, дүрийн цэс. Sidebar зөвхөн үүнийг зурна. */
  me: MeResponse | undefined;
  /** Сесс дундаа дууссан (refresh амжилтгүй) — нэвтрэх хуудсанд мэдэгдэнэ. */
  expired: boolean;
  login(body: LoginRequest): Promise<void>;
  logout(): Promise<void>;
  retry(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
export const ME_KEY = ['auth', 'me'] as const;
const meOf = ({ user, permissions, menu }: AuthResponse): MeResponse => ({ user, permissions, menu });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('booting');
  const [expired, setExpired] = useState(false);

  const boot = useCallback(async () => {
    setStatus('booting');
    try {
      const s = await refreshSession();
      if (s) qc.setQueryData(ME_KEY, meOf(s));
      setStatus(s ? 'authenticated' : 'anonymous');
    } catch {
      setStatus('unreachable');
    }
  }, [qc]);
  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(
    () =>
      onSessionEnded(() => {
        qc.clear();
        setExpired(true);
        setStatus('anonymous');
      }),
    [qc],
  );

  // Цэс/эрх өөрчлөгдсөнийг (админ дүр солисон) таб руу буцахад авна; login/refresh-ийн хариуг cache-д урьдчилан хийсэн.
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
      setExpired(false);
      setStatus('authenticated');
    },
    [qc],
  );
  const logout = useCallback(async () => {
    await logoutRequest();
    qc.clear();
    setExpired(false);
    setStatus('anonymous');
  }, [qc]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, me: meQuery.data, expired, login, logout, retry: () => void boot() }),
    [status, meQuery.data, expired, login, logout, boot],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
