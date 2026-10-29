import type { ESignProvider, PublicSigningSession } from '@los/contracts';
import { documentUrl, signedDocumentUrl, type EsignApiError } from './api';
import type { FlowStep } from './flow';
import { errorMessage } from './messages';
import { ChooseStep } from './steps/ChooseStep';
import { ErrorPanel, LoadingPanel, TerminalResult } from './steps/ResultStep';
import { ReviewStep } from './steps/ReviewStep';
import { Shell } from './steps/Shell';
import { SignedStep } from './steps/SignedStep';
import { WaitingStep } from './steps/WaitingStep';

export interface SigningViewModel {
  token: string;
  session: PublicSigningSession | null;
  /** null — ачаалж байна эсвэл түр алдаатай (loadError-оор ялгана) */
  step: FlowStep | null;
  /** session-гүй үеийн түр алдаа (сүлжээ, 5xx, 429) */
  loadError: EsignApiError | null;
  /** waiting үед polling амжилтгүй (хуучин өгөгдөл харагдаж байна) */
  connectionLost: boolean;
  starting: boolean;
  startError: EsignApiError | null;
  declining: boolean;
  declineError: EsignApiError | null;
  /** Тестэд Countdown-ийн "одоо" цагийг тогтмол болгоно */
  initialNowMs?: number;
}

export interface SigningViewActions {
  onFrameLoad: () => void;
  onOpenFull: () => void;
  onContinue: () => void;
  onStart: (provider: ESignProvider) => void;
  onDecline: () => void;
  onRetry: () => void;
  onCountdownElapsed: () => void;
}

const PROGRESS = { review: 0, choose: 1, waiting: 2 } as const;

/** Төлвийн загвар → дэлгэц. Hook-гүй, сервер талд ч render хийгдэнэ (smoke тест). */
export function SigningView({ model, actions }: { model: SigningViewModel; actions: SigningViewActions }) {
  const { session, step } = model;
  const progress = step !== null && step.step in PROGRESS ? PROGRESS[step.step as keyof typeof PROGRESS] : undefined;
  return (
    <Shell contractNo={session?.contractNo} signerNameMasked={session?.signerNameMasked} progress={progress}>
      {renderBody(model, actions)}
    </Shell>
  );
}

function renderBody({ token, session, step, loadError, connectionLost, starting, startError, declining, declineError, initialNowMs }: SigningViewModel, actions: SigningViewActions) {
  if (step === null) return loadError === null ? <LoadingPanel /> : <ErrorPanel kind={loadError.kind} onRetry={actions.onRetry} />;
  switch (step.step) {
    case 'notFound':
    case 'declined':
    case 'expired':
    case 'cancelled':
      return <TerminalResult kind={step.step} />;
    case 'failed':
      return <TerminalResult kind="failed" reason={step.reason} />;
  }
  // Үлдсэн алхмууд session шаарддаг
  if (session === null) return <LoadingPanel />;
  switch (step.step) {
    case 'review':
      return (
        <ReviewStep session={session} documentSrc={documentUrl(token)} onFrameLoad={actions.onFrameLoad} onOpenFull={actions.onOpenFull} onContinue={actions.onContinue} />
      );
    case 'choose':
      return (
        <ChooseStep
          session={session}
          retryReason={step.retryReason}
          submitting={starting}
          error={startError === null ? null : errorMessage(startError.kind)}
          onSubmit={actions.onStart}
        />
      );
    case 'waiting':
      return (
        <WaitingStep
          session={session}
          phase={step.phase}
          connectionLost={connectionLost}
          declining={declining}
          error={declineError === null ? null : errorMessage(declineError.kind)}
          initialNowMs={initialNowMs}
          onDecline={actions.onDecline}
          onCountdownElapsed={actions.onCountdownElapsed}
        />
      );
    case 'signed':
      return (
        <SignedStep
          session={session}
          signedDocumentHref={signedDocumentUrl(token)}
          verifyHref={session.verificationCode === null ? null : `/verify/${encodeURIComponent(session.verificationCode)}`}
          nowMs={initialNowMs}
        />
      );
  }
}
