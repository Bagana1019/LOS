import type { PublicSigningSession } from '@los/contracts';
import type { QueryClient, QueryObserverOptions } from '@tanstack/react-query';
import { fetchSession, fetchStatus, isValidSigningToken } from './api';
import { deriveStep, pollIntervalMs, stepForError } from './flow';
import { sessionKey, toApiError } from './query';

/** waiting алхамд орсон цагийг хадгалах (React ref-тэй ижил хэлбэр) */
export interface WaitingClock {
  current: number | null;
}

/**
 * Зээлдэгчийн session-ийн query тохиргоо: анх `GET :token`, утсан дээр баталгаажуулалт хүлээх (waiting) үед `GET :token/status`-аар
 * polling (2 с → 60 с-ын дараа 5 с, алдаа/429-д ухарна), төгсгөлийн төлөв эсвэл 404/410 дээр зогсоно.
 * tab нуугдсан үед TanStack өөрөө зогсоож (refetchIntervalInBackground=false), харагдахад шууд шинэчилнэ.
 */
export function sessionQueryOptions(token: string, queryClient: QueryClient, waiting: WaitingClock, now: () => number = Date.now): QueryObserverOptions<PublicSigningSession, Error> {
  const queryKey = sessionKey(token);
  return {
    queryKey,
    enabled: isValidSigningToken(token),
    queryFn: ({ signal }) => {
      const cached = queryClient.getQueryData<PublicSigningSession>(queryKey);
      // Утсан дээр баталгаажуулалт хүлээж байх үед л /status (polling-ийн тусдаа rate бүлэг)
      return cached !== undefined && deriveStep(cached, false).step === 'waiting' ? fetchStatus(token, signal) : fetchSession(token, signal);
    },
    refetchInterval: (query) => {
      const error = query.state.error === null ? null : toApiError(query.state.error);
      if (query.state.data === undefined || (error !== null && stepForError(error.kind) !== null)) return false;
      const step = deriveStep(query.state.data, false);
      if (step.step !== 'waiting') {
        waiting.current = null;
        return false;
      }
      waiting.current ??= now();
      return pollIntervalMs(step, { elapsedMs: now() - waiting.current, failures: query.state.fetchFailureCount, retryAfterMs: error?.retryAfterMs ?? null });
    },
  };
}
