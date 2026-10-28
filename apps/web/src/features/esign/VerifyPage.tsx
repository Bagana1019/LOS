'use client';

import type { SigningVerification } from '@los/contracts';
import { useQuery } from '@tanstack/react-query';
import { fetchVerification, normalizeVerificationCode } from './api';
import { t } from './i18n';
import { PublicProviders } from './PublicProviders';
import { toApiError } from './query';
import { ErrorPanel, LoadingPanel } from './steps/ResultStep';
import { Shell } from './steps/Shell';
import { VerifyNotFound, VerifyView } from './VerifyView';

/** QR кодоор нээгдэх нийтийн баталгаажуулалтын хуудас — `/verify/[code]`. */
export function VerifyPage({ code }: { code: string }) {
  return (
    <PublicProviders>
      <VerifyContainer code={code} />
    </PublicProviders>
  );
}

function VerifyContainer({ code }: { code: string }) {
  const normalized = normalizeVerificationCode(code);
  const query = useQuery<SigningVerification, Error>({
    queryKey: ['esign', 'verify', normalized],
    enabled: normalized !== null,
    queryFn: ({ signal }) => fetchVerification(code, signal),
  });

  if (normalized === null) return <VerifyNotFound />;
  if (query.data !== undefined) return <VerifyView verification={query.data} />;
  if (query.error !== null) {
    const { kind } = toApiError(query.error);
    return kind === 'NOT_FOUND' ? (
      <VerifyNotFound />
    ) : (
      <Shell title={t('verify.page.title')}>
        <ErrorPanel kind={kind} onRetry={() => void query.refetch()} />
      </Shell>
    );
  }
  return (
    <Shell title={t('verify.page.title')}>
      <LoadingPanel label={t('verify.loading')} />
    </Shell>
  );
}
