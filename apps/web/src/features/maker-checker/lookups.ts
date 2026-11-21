'use client';
// Best-effort lookups that make a change request readable (F8-3, F9-5). A failed lookup (no access, deleted record) is not an error for the
// drawer: the caller falls back to the raw id as secondary text. Lookups never retry and never block the decision buttons.
import { useQuery } from '@tanstack/react-query';
import { BlacklistEntry } from '@los/contracts';
import { originationFetch } from '../../lib/api';
import { fetchProducts } from '../admin/admin.api';
import { useDirectory } from '../applications/useApplications';
import { mcKeys } from './hooks';
import { resolveName } from './names';

const LOOKUP_STALE_MS = 60_000;

export interface DirectoryNames {
  user: (id: string) => string | null;
  branch: (id: string) => string | null;
}

/** User / branch names from the org directory (readable by every signed-in staff role). Unknown or still loading → null. */
export function useDirectoryNames(): DirectoryNames {
  const { data } = useDirectory();
  return { user: (id) => resolveName(data?.users, id), branch: (id) => resolveName(data?.branches, id) };
}

/** `GET /blacklist/:id` is open to every signed-in role (only writes need blacklist:manage). */
export const useBlacklistEntry = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: [...mcKeys.all, 'lookup', 'blacklist', id],
    queryFn: () => originationFetch<BlacklistEntry>(`/blacklist/${encodeURIComponent(id)}`, { schema: BlacklistEntry }),
    enabled,
    retry: false,
    staleTime: LOOKUP_STALE_MS,
  });

/** Product name for a request whose snapshot has none (SET_ACTIVE stores only isActive). The product list needs settings:manage: others get null. */
export const useProductName = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: [...mcKeys.all, 'lookup', 'product', id],
    queryFn: async () => (await fetchProducts()).find((p) => p.id === id)?.name ?? null,
    enabled,
    retry: false,
    staleTime: LOOKUP_STALE_MS,
  });
