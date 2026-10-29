'use client';
import { Alert, Button, Collapse, Drawer, Result, Skeleton, Space, Typography } from 'antd';
import { mn } from '@los/ui';
import type { ChangeRequestDto } from '@los/contracts';
import { useNow, useRequest } from '../hooks';
import { errorText, isApiError } from '../errors';
import { DiffTable } from './DiffTable';
import { RequestActions } from './RequestActions';
import { RequestSummary } from './RequestSummary';
import { RequestTimeline } from './RequestTimeline';
import type { DecisionHandlers } from './useDecisionFlow';

const { Title, Paragraph, Text } = Typography;

const pretty = (v: unknown): string => JSON.stringify(v ?? null, null, 2);

/** Banner explaining a terminal state; FAILED and REJECTED are the ones the user has to act on. */
function StatusNotes({ dto }: { dto: ChangeRequestDto }) {
  switch (dto.status) {
    case 'FAILED':
      return (
        <Alert
          type="error"
          showIcon
          message={mn['maker_checker.note.failed_title']}
          description={
            <>
              <Paragraph strong style={{ marginBottom: 4 }}>
                {dto.failureReason ?? ''}
              </Paragraph>
              <Text type="secondary">{mn['maker_checker.note.failed_hint']}</Text>
            </>
          }
        />
      );
    case 'REJECTED':
      return (
        <Alert
          type="warning"
          showIcon
          message={mn['maker_checker.note.rejected_title']}
          description={<span style={{ whiteSpace: 'pre-wrap' }}>{dto.checkerComment ?? mn['maker_checker.note.rejected_empty']}</span>}
        />
      );
    case 'EXPIRED':
      return <Alert type="info" showIcon message={mn['maker_checker.note.expired']} />;
    case 'CANCELLED':
      return <Alert type="info" showIcon message={mn['maker_checker.note.cancelled']} />;
    case 'APPLIED':
      return dto.mode === 'DIRECT' ? <Alert type="info" showIcon message={mn['maker_checker.note.direct']} /> : null;
    default:
      return null;
  }
}

function DrawerBody({ dto }: { dto: ChangeRequestDto }) {
  const now = useNow();
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <StatusNotes dto={dto} />
      <RequestSummary dto={dto} now={now} />
      <section>
        <Title level={5}>{mn['maker_checker.drawer.reason']}</Title>
        <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{dto.reason}</Paragraph>
      </section>
      <section>
        <Title level={5}>{mn['maker_checker.drawer.diff']}</Title>
        {dto.before == null && <Paragraph type="secondary">{mn['maker_checker.diff.no_before']}</Paragraph>}
        <DiffTable before={dto.before} payload={dto.payload} />
        <Collapse
          ghost
          style={{ marginTop: 8 }}
          items={[
            {
              key: 'raw',
              label: mn['maker_checker.drawer.raw'],
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Text type="secondary">{mn['maker_checker.raw.before']}</Text>
                  <pre style={{ margin: 0, maxHeight: 280, overflow: 'auto', fontSize: 12 }}>{pretty(dto.before)}</pre>
                  <Text type="secondary">{mn['maker_checker.raw.payload']}</Text>
                  <pre style={{ margin: 0, maxHeight: 280, overflow: 'auto', fontSize: 12 }}>{pretty(dto.payload)}</pre>
                </Space>
              ),
            },
          ]}
        />
      </section>
      <section>
        <Title level={5}>{mn['maker_checker.drawer.timeline']}</Title>
        <RequestTimeline history={dto.history} />
      </section>
    </Space>
  );
}

interface Props {
  /** null = closed */
  id: string | null;
  onClose: () => void;
  handlers: DecisionHandlers;
}

export function RequestDrawer({ id, onClose, handlers }: Props) {
  const { data, error, isPending, refetch } = useRequest(id);

  const body = () => {
    if (id === null || isPending) return <Skeleton active paragraph={{ rows: 10 }} />;
    if (!data) {
      if (isApiError(error, 404)) return <Result status="404" subTitle={errorText(error)} />;
      return (
        <Alert
          type="error"
          showIcon
          message={mn['maker_checker.drawer.error_title']}
          description={errorText(error)}
          action={<Button onClick={() => void refetch()}>{mn['maker_checker.table.retry']}</Button>}
        />
      );
    }
    return <DrawerBody dto={data} />;
  };

  const hasActions = data !== undefined && (data.canDecide === true || data.canCancel === true);

  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      width={760}
      destroyOnHidden
      title={mn['maker_checker.drawer.title']}
      extra={<Button onClick={onClose}>{mn['maker_checker.btn.close']}</Button>}
      footer={hasActions ? <RequestActions dto={data} handlers={handlers} variant="footer" /> : null}
    >
      {body()}
    </Drawer>
  );
}
