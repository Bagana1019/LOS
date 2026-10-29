'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ESIGN_CONSENT_VERSION, type ESignProvider, type PublicSigningSession } from '@los/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { declineSigning, isValidSigningToken, startSigning, type EsignApiError } from './api';
import { deriveStep, stepForError, type FlowStep } from './flow';
import { PublicProviders } from './PublicProviders';
import { sessionKey, toApiError } from './query';
import { sessionQueryOptions } from './session-query';
import { SigningView } from './SigningView';

/** "Бүтнээр нээх" дарснаас хойш session-ийг дахин авах хүртэлх хоцрол (шинэ tab-д PDF ачаалагдах хугацаа) */
const VIEWED_REFRESH_DELAY_MS = 1_500;

/** Зээлдэгчийн гарын үсгийн урсгал — `/sign/[token]`. Токеныг лог/гарчигт хэзээ ч бичихгүй. */
export function SigningFlow({ token }: { token: string }) {
  return (
    <PublicProviders>
      <SigningFlowContainer token={token} />
    </PublicProviders>
  );
}

function SigningFlowContainer({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const tokenValid = isValidSigningToken(token);
  const key = sessionKey(token);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  // waiting алхамд орсон цаг — polling 2 с → 5 с болгох суурь
  const waitingSince = useRef<number | null>(null);
  const viewedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useQuery<PublicSigningSession, Error>(sessionQueryOptions(token, queryClient, waitingSince));

  const refreshSession = useCallback(() => queryClient.invalidateQueries({ queryKey: sessionKey(token) }), [queryClient, token]);
  // Mutation-ий алдаа төлвийн зөрүүг илтгэж болно (409, 404, 410) → серверийн бодит төлвийг шууд авна
  const resync = useCallback(
    (err: Error) => {
      const { kind } = toApiError(err);
      if (kind === 'CONFLICT' || kind === 'NOT_FOUND' || kind === 'GONE') void refreshSession();
    },
    [refreshSession],
  );

  const start = useMutation<PublicSigningSession, Error, ESignProvider>({
    // Зээлдэгчийн харсан зөвшөөрлийн текстийн хувилбарыг (session-оос) буцаана; серверийнхээс зөрвөл 409 → дахин ачаална
    mutationFn: (provider) => startSigning(token, { provider, consent: true, consentVersion: queryClient.getQueryData<PublicSigningSession>(key)?.consentVersion ?? ESIGN_CONSENT_VERSION }),
    onSuccess: (session) => queryClient.setQueryData(key, session),
    onError: resync,
  });
  const decline = useMutation<PublicSigningSession, Error>({
    mutationFn: () => declineSigning(token),
    onSuccess: (session) => queryClient.setQueryData(key, session),
    onError: resync,
  });

  useEffect(
    () => () => {
      if (viewedTimer.current !== null) clearTimeout(viewedTimer.current);
    },
    [],
  );

  const session = query.data ?? null;
  const error: EsignApiError | null = query.error === null ? null : toApiError(query.error);
  const errorStep: FlowStep | null = !tokenValid ? { step: 'notFound' } : error === null ? null : stepForError(error.kind);
  const step = errorStep ?? (session === null ? null : deriveStep(session, reviewAcknowledged));
  // Session байхгүй үеийн түр алдаа → дахин оролдох самбар; session байхад polling-ийн алдаа → "холболт тасарлаа" анхааруулга
  const loadError = session === null && step === null ? error : null;
  const connectionLost = session !== null && error !== null && errorStep === null;

  return (
    <SigningView
      model={{
        token,
        session,
        step,
        loadError,
        connectionLost,
        starting: start.isPending,
        startError: start.error === null ? null : toApiError(start.error),
        declining: decline.isPending,
        declineError: decline.error === null ? null : toApiError(decline.error),
      }}
      actions={{
        onFrameLoad: () => void refreshSession(),
        onOpenFull: () => {
          if (viewedTimer.current !== null) clearTimeout(viewedTimer.current);
          viewedTimer.current = setTimeout(() => void refreshSession(), VIEWED_REFRESH_DELAY_MS);
        },
        onContinue: () => setReviewAcknowledged(true),
        onStart: (provider) => start.mutate(provider),
        onDecline: () => decline.mutate(),
        onRetry: () => void query.refetch(),
        onCountdownElapsed: () => void refreshSession(),
      }}
    />
  );
}
