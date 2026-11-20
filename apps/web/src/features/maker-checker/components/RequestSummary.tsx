'use client';
import { Descriptions, Tag, Typography, type DescriptionsProps } from 'antd';
import { mn } from '@los/ui';
import type { ChangeRequestDto } from '@los/contracts';
import type { ContextRow } from '../change-view';
import { describeChange, modeLabel, roleLabel } from '../labels';
import type { DirectoryNames } from '../lookups';
import { isUuid } from '../names';
import { formatDateTime, isUrgent } from '../time';
import { PersonLabel, SECONDARY_SMALL } from './PersonLabel';
import { StatusTag } from './StatusTag';

const { Text } = Typography;

const Roles = ({ roles }: { roles: string[] }) => (
  <>
    {roles.map((r) => (
      <Tag key={r}>{roleLabel(r)}</Tag>
    ))}
  </>
);

/** What is known about the target beyond its id (F8-3, F9-5). */
export interface TargetInfo {
  /** Readable name (blacklisted person, product); null when unknown. */
  name: string | null;
  /** The lookup that should have produced the name failed (no access / deleted). */
  unavailable: boolean;
  /** Extra rows (masked register, list type, reason) shown under the target. */
  context: ContextRow[];
}

const NO_NAMES: DirectoryNames = { user: () => null, branch: () => null };
const NO_TARGET: TargetInfo = { name: null, unavailable: false, context: [] };

/** Name first; the id (UUID) only as secondary small text, copyable. A non-UUID id (e.g. a setting key) is meaningful and stays normal text. */
function TargetCell({ id, info }: { id: string; info: TargetInfo }) {
  const secondary = info.name !== null || isUuid(id);
  return (
    <div data-testid="mc-target">
      {info.name !== null && (
        <div>
          <Text strong>
            <span data-testid="mc-target-name">{info.name}</span>
          </Text>
        </div>
      )}
      {info.name === null && info.unavailable && (
        <div>
          <Text type="secondary">{mn['maker_checker.target.unavailable']}</Text>
        </div>
      )}
      <Text type={secondary ? 'secondary' : undefined} style={secondary ? SECONDARY_SMALL : undefined} copyable={{ text: id }}>
        <span data-testid="mc-target-id">{id}</span>
      </Text>
    </div>
  );
}

interface Props {
  dto: ChangeRequestDto;
  now: number;
  /** User / branch names from the directory; without them ids stay as secondary text. */
  names?: DirectoryNames;
  target?: TargetInfo;
}

/** Header summary of a request: who proposed what, when, and who decided. */
export function RequestSummary({ dto, now, names = NO_NAMES, target = NO_TARGET }: Props) {
  const { title, code } = describeChange(dto.targetType, dto.action);
  const urgent = isUrgent(dto.status, dto.expiresAt, now);

  const items: DescriptionsProps['items'] = [
    { key: 'id', span: 2, label: mn['maker_checker.field.id'], children: <Text copyable code>{dto.id}</Text> },
    // The raw "TARGET / ACTION" code is technical: it stays out of the main text (hover shows it; the raw JSON panel lists it).
    { key: 'type', span: 2, label: mn['maker_checker.field.type'], children: <span title={code ?? undefined}>{title}</span> },
    { key: 'target', span: 2, label: mn['maker_checker.field.target'], children: <TargetCell id={dto.targetId} info={target} /> },
    ...target.context.map((row) => ({ key: `ctx-${row.key}`, span: 2, label: row.label, children: row.value })),
    { key: 'status', label: mn['maker_checker.col.status'], children: <StatusTag status={dto.status} mode={dto.mode} /> },
    { key: 'mode', label: mn['maker_checker.field.mode'], children: modeLabel(dto.mode) },
    {
      key: 'maker',
      label: mn['maker_checker.field.maker'],
      children: (
        <span data-testid="mc-maker">
          <PersonLabel id={dto.makerId} name={names.user(dto.makerId)} /> <Roles roles={dto.makerRoles} />
        </span>
      ),
    },
    { key: 'created', label: mn['maker_checker.field.created_at'], children: formatDateTime(dto.createdAt) },
  ];

  if (dto.applicationId) items.push({ key: 'application', label: mn['maker_checker.field.application'], children: dto.applicationId });
  if (dto.branchId) items.push({ key: 'branch', label: mn['maker_checker.field.branch'], children: <PersonLabel id={dto.branchId} name={names.branch(dto.branchId)} /> });
  if (dto.requiredCheckerRoles.length > 0) {
    items.push({ key: 'required', label: mn['maker_checker.field.required_roles'], children: <Roles roles={dto.requiredCheckerRoles} /> });
  }
  items.push({
    key: 'expires',
    label: mn['maker_checker.field.expires_at'],
    children: <Text type={urgent ? 'danger' : undefined}>{formatDateTime(dto.expiresAt)}</Text>,
  });
  if (dto.checkerId) {
    items.push({
      key: 'checker',
      label: mn['maker_checker.field.checker'],
      children: (
        <>
          <PersonLabel id={dto.checkerId} name={names.user(dto.checkerId)} /> <Roles roles={dto.checkerRoles} />
        </>
      ),
    });
  }
  if (dto.decidedAt) items.push({ key: 'decided', label: mn['maker_checker.field.decided_at'], children: formatDateTime(dto.decidedAt) });

  return <Descriptions bordered size="small" column={2} items={items} />;
}
