// Exponential backoff + jitter. attemptsMade = одоогоор хийгдсэн оролдлогын тоо (1 = эхний оролдлого амжилтгүй болсон).
export interface RetryPolicy { baseDelayMs: number; factor: number; maxDelayMs: number; jitterRatio: number; maxAttempts: number; }

export function backoffDelayMs(policy: RetryPolicy, attemptsMade: number, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** Math.max(0, attemptsMade - 1));
  const jitter = 1 + (random() * 2 - 1) * policy.jitterRatio;
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(exp * jitter)));
}
