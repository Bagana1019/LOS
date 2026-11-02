'use client';
import type { ReactNode } from 'react';
import { Flex, Tag, Typography } from 'antd';

// docs/01 §2.2: зүүн самбар — алхам бүрийн төлөв (дугаар/✓/цоож), үе шатын тоолуур (6/9). Цэвэр presentational: өгөгдөл, чиглүүлэлтийг дуудагч өгнө.
export type WizardStepStatus = 'LOCKED' | 'PENDING' | 'COMPLETED' | 'STALE';

export interface WizardStep {
  key: string;
  label: string;
  status: WizardStepStatus;
  /** Нэмэлт тайлбар (жишээ нь "Заавал"). */
  hint?: string;
}

export interface WizardStage {
  key: string;
  title: string;
  /** Тоолуур, ж: "6/9 алхам бүрдсэн". */
  counter?: string;
  steps: WizardStep[];
}

export interface WizardLayoutProps {
  stages: WizardStage[];
  activeKey: string;
  onSelect: (stepKey: string) => void;
  header?: ReactNode;
  lockedTitle?: string;
  statusLabel: (s: WizardStepStatus) => string;
  children: ReactNode;
}

const MARK: Record<WizardStepStatus, string> = { LOCKED: '🔒', PENDING: '', COMPLETED: '✓', STALE: '!' };
const COLOR: Record<WizardStepStatus, string> = { LOCKED: 'default', PENDING: 'blue', COMPLETED: 'green', STALE: 'orange' };

export function WizardLayout({ stages, activeKey, onSelect, header, lockedTitle, statusLabel, children }: WizardLayoutProps) {
  let n = 0;
  return (
    <Flex gap={24} wrap align="flex-start" style={{ width: '100%' }}>
      <nav aria-label="wizard" style={{ flex: '0 0 280px', maxWidth: '100%', minWidth: 240 }}>
        {header}
        {stages.map((stage) => (
          <div key={stage.key} style={{ marginBottom: 16 }}>
            <Flex justify="space-between" align="baseline" style={{ marginBottom: 8 }}>
              <Typography.Text strong>{stage.title}</Typography.Text>
              {stage.counter ? <Typography.Text type="secondary" data-testid={`counter-${stage.key}`}>{stage.counter}</Typography.Text> : null}
            </Flex>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {stage.steps.map((s) => {
                n += 1;
                const locked = s.status === 'LOCKED';
                const active = s.key === activeKey;
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      disabled={locked}
                      title={locked ? lockedTitle : undefined}
                      aria-current={active ? 'step' : undefined}
                      data-status={s.status}
                      data-testid={`step-${s.key}`}
                      onClick={() => onSelect(s.key)}
                      style={{
                        display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 2, textAlign: 'left',
                        border: 'none', borderRadius: 6, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.55 : 1,
                        background: active ? 'rgba(22,119,255,0.12)' : 'transparent', font: 'inherit', color: 'inherit',
                      }}
                    >
                      <Tag color={COLOR[s.status]} style={{ marginInlineEnd: 0, minWidth: 28, textAlign: 'center' }}>{MARK[s.status] || n}</Tag>
                      <span style={{ flex: 1 }}>{s.label}</span>
                      {s.hint ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.hint}</Typography.Text> : null}
                      <span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{statusLabel(s.status)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </nav>
      <section style={{ flex: '1 1 480px', minWidth: 0 }}>{children}</section>
    </Flex>
  );
}
