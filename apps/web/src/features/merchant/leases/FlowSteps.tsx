import type { PosLeaseStatus } from '@los/contracts';
import { t } from '../../../lib/i18n';
import { Icon } from '../icons';
import { FLOW_STEP_KEYS, flowStepIndex } from '../status';

const ERROR_STATUSES: readonly PosLeaseStatus[] = ['DECLINED', 'CANCELLED', 'EXPIRED'];

/** 6 алхамт урсгалын заагч. Утсанд зөвхөн идэвхтэй алхамын нэр харагдана. */
export function FlowSteps({ status, acceptStage }: { status: PosLeaseStatus; acceptStage: boolean }) {
  const current = flowStepIndex(status, acceptStage);
  const failed = ERROR_STATUSES.includes(status);
  return (
    <ol className="mp-steps" aria-label={t('pos.flow.label')}>
      {FLOW_STEP_KEYS.map((key, i) => {
        const state = i < current ? 'done' : i === current ? (failed ? 'error' : 'current') : 'todo';
        return (
          <li key={key} className={`mp-step is-${state}`} aria-current={state === 'current' || state === 'error' ? 'step' : undefined}>
            <span className="mp-step-dot">{state === 'done' ? <Icon name="check" size={14} /> : i + 1}</span>
            <span className="mp-step-label">{t(key)}</span>
          </li>
        );
      })}
    </ol>
  );
}
