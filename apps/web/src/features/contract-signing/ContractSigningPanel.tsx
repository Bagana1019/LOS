'use client';

import { useState } from 'react';
import type { ESignProvider } from '@los/contracts';
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t, type MnKey } from '../esign/i18n';
import { cancelSigning, getSigning, resendSigning, startSigning, type StaffSigningView } from './api';
import { errorText } from './messages';
import { PanelView } from './PanelView';
import { createPanelQueryClient, panelKey, toSigningApiError } from './query';
import { isActive, panelStatus } from './status';

/** Идэвхтэй хүсэлтийн төлвийг шинэчлэх давтамж (зээлдэгч гарын үсэг зурсныг ажилтан харахын тулд) */
export const ACTIVE_REFRESH_MS = 15_000;

type Command = { type: 'send'; provider: ESignProvider | null } | { type: 'resend' } | { type: 'cancel' };

const NOTICE_KEYS = {
  send: 'contractSigning.notice.sent',
  resend: 'contractSigning.notice.resent',
  cancel: 'contractSigning.notice.cancelled',
} as const satisfies Record<Command['type'], MnKey>;

export interface ContractSigningPanelProps {
  applicationId: string;
}

/**
 * FR-11.4 — гэрээний алхамд суулгах ажилтны самбар: цахим гарын үсгийн төлөв + илгээх / дахин илгээх / цуцлах.
 * Гэрээний wizard-ийн алхамд (Module 2/11) холбохдоо `features/contract-signing`-аас импортлоно.
 */
export function ContractSigningPanel({ applicationId }: ContractSigningPanelProps) {
  const [client] = useState(createPanelQueryClient);
  return (
    <QueryClientProvider client={client}>
      <PanelContainer applicationId={applicationId} />
    </QueryClientProvider>
  );
}

function PanelContainer({ applicationId }: ContractSigningPanelProps) {
  const queryClient = useQueryClient();
  const key = panelKey(applicationId);
  const [preferred, setPreferred] = useState<ESignProvider | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const query = useQuery<StaffSigningView | null, Error>({
    queryKey: key,
    queryFn: ({ signal }) => getSigning(applicationId, signal),
    refetchInterval: (q) => (isActive(panelStatus(q.state.data ?? null)) ? ACTIVE_REFRESH_MS : false),
  });

  const command = useMutation<StaffSigningView, Error, Command>({
    mutationFn: (cmd) => {
      switch (cmd.type) {
        case 'send':
          return startSigning(applicationId, cmd.provider ?? undefined);
        case 'resend':
          return resendSigning(applicationId);
        case 'cancel':
          return cancelSigning(applicationId);
      }
    },
    onMutate: () => setNotice(null),
    onSuccess: (view, cmd) => {
      queryClient.setQueryData(key, view);
      setNotice(t(NOTICE_KEYS[cmd.type]));
    },
    onError: (err) => {
      // Төлөв зөрсөн (409) эсвэл хүсэлт алга болсон (404) бол бодит төлвийг дахин авна
      const { kind } = toSigningApiError(err);
      if (kind === 'CONFLICT' || kind === 'NOT_FOUND') void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const loadFailed = query.error !== null && query.data === undefined;
  const error = command.error !== null ? errorText(toSigningApiError(command.error)) : loadFailed ? errorText(toSigningApiError(query.error)) : null;

  return (
    <PanelView
      view={query.data ?? null}
      loading={query.isPending}
      busy={command.isPending}
      notice={notice}
      error={error}
      preferred={preferred}
      onPreferredChange={setPreferred}
      onSend={() => command.mutate({ type: 'send', provider: preferred })}
      onResend={() => command.mutate({ type: 'resend' })}
      onCancel={() => command.mutate({ type: 'cancel' })}
      onRefresh={() => void query.refetch()}
    />
  );
}
