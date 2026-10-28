// Typed fetch wrapper for `${API}/origination/maker-checker` (gateway only - CLAUDE.md §3.2 rule 1; gateway: /api/<service>/<path>).
// Every response is parsed with the @los/contracts zod schemas; failures throw ApiError.
import { z } from 'zod';
import {
  ChangeRequestDto,
  ChangeRequestPage,
  ChangeRequestSummary,
  MakerCheckerPolicyDto,
  SubmitChangeResult,
  type ChangeRequestScope,
  type ChangeRequestStatus,
  type MakerCheckerPolicy,
} from '@los/contracts';
import { mn } from '@los/ui';
import { API } from '../../lib/api';
import { ApiError, buildApiError } from './errors';

const BASE = `${API}/origination/maker-checker`;

/** The one method of a zod schema we need; avoids coupling to a zod version. */
interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export interface RequestsFilter {
  scope: ChangeRequestScope;
  status?: ChangeRequestStatus;
  targetType?: string;
  page: number;
  pageSize: number;
}

export type PolicyUpdate = Pick<MakerCheckerPolicy, 'enabled' | 'checkerRoles' | 'expiresInHours'> & { reason: string };

/** `?a=1&b=2` without empty values; '' when there is nothing to send. */
export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  parser: Parser<T>,
  opts: { body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const hasBody = opts.body !== undefined;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: hasBody ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', mn['maker_checker.error.network']);
  }
  const json = await readJson(res);
  if (!res.ok) throw buildApiError(res.status, json);
  const parsed = parser.safeParse(json);
  if (!parsed.success) throw new ApiError(res.status, 'INVALID_RESPONSE', mn['maker_checker.error.invalid_response'], parsed.error);
  return parsed.data;
}

const id = encodeURIComponent;
const PoliciesResponse = z.array(MakerCheckerPolicyDto);

export const listRequests = (f: RequestsFilter, signal?: AbortSignal) =>
  request('GET', `/requests${buildQuery({ scope: f.scope, status: f.status, targetType: f.targetType, page: f.page, pageSize: f.pageSize })}`, ChangeRequestPage, { signal });

export const getSummary = (signal?: AbortSignal) => request('GET', '/requests/summary', ChangeRequestSummary, { signal });

export const getRequest = (requestId: string, signal?: AbortSignal) => request('GET', `/requests/${id(requestId)}`, ChangeRequestDto, { signal });

export const approveRequest = (requestId: string, comment?: string) =>
  request('POST', `/requests/${id(requestId)}/approve`, ChangeRequestDto, { body: { comment: comment?.trim() || undefined } });

export const rejectRequest = (requestId: string, comment: string) =>
  request('POST', `/requests/${id(requestId)}/reject`, ChangeRequestDto, { body: { comment: comment.trim() } });

export const cancelRequest = (requestId: string, comment?: string) =>
  request('POST', `/requests/${id(requestId)}/cancel`, ChangeRequestDto, { body: { comment: comment?.trim() || undefined } });

export const listPolicies = (signal?: AbortSignal) => request('GET', '/policies', PoliciesResponse, { signal });

/** Changing a policy is itself a four-eyes change: the server answers 202 with outcome PENDING. */
export const updatePolicy = (targetType: string, action: string, update: PolicyUpdate) =>
  request('PUT', `/policies/${id(targetType)}/${id(action)}`, SubmitChangeResult, { body: { ...update, reason: update.reason.trim() } });
