'use client';
import { useMemo } from 'react';
import { useAuth } from '../../lib/auth/auth-context';
import { useDirectory } from '../applications/useApplications';
import { lookupScopeOf, type LookupStatus, type Lookups } from './report-lookups';

/**
 * F11-1: салбар / ЗЭЗ-ийн нэрс. Эх сурвалж — gateway `GET /api/directory` (нэвтэрсэн ЯМАР Ч ажилтан уншина: settings:manage шаардахгүй),
 * `useDirectory`-тэй ижил cache түлхүүр тул дашбоард, тайлан, хүсэлтийн жагсаалт нэг хүсэлтийг хуваалцана. Хүрээ нь нэвтэрсэн хэрэглэгчийн дүрээс.
 */
export function useLookups(): Lookups {
  const { me } = useAuth();
  const directory = useDirectory();
  const user = me?.user;
  const scope = useMemo(() => lookupScopeOf(user), [user]);
  const status: LookupStatus = directory.data ? 'ready' : directory.isError ? 'failed' : 'loading';
  return { directory: directory.data, status, scope };
}
