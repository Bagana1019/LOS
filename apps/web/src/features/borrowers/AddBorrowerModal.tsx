'use client';
import { useState } from 'react';
import { App as AntApp, Alert, Button, Card, Empty, Flex, Form, Input, Modal, Select, Skeleton, Tag, Typography, theme } from 'antd';
import type { BorrowerCandidate, BorrowerRole, BorrowerSummary, BorrowerView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from './ApiErrorAlert';
import { BorrowerFormFields } from './BorrowerFormFields';
import { useAddBorrower, useBorrowerCandidates } from './useBorrowers';
import {
  REGISTER_MAX_LENGTH, ROLE_COLOR, buildAddRequest, candidateRoleOptions, customerTypeKey, firstEnabledRole, isSearchableRegisterNo,
  normalizeRegisterNo, remainingSharePercent, roleDefaults, roleHintKey, roleKey, type BorrowerFormValues, type RoleOption,
} from './borrowers.utils';

interface Props {
  open: boolean;
  applicationId: string;
  items: readonly BorrowerView[];
  summary: BorrowerSummary;
  onClose: () => void;
  onChanged?: () => void;
}

/** Регистрээр харилцагч хайх → сонгох → дүр + дүрээс хамаарсан талбар → нэмэх (FR-2.1, FR-2.2). */
export function AddBorrowerModal({ open, ...rest }: Props) {
  return (
    <Modal open={open} title={t('borrower.add.title')} onCancel={rest.onClose} footer={null} width={680} destroyOnHidden maskClosable={false}>
      <AddBorrowerBody {...rest} />
    </Modal>
  );
}

function AddBorrowerBody({ applicationId, items, summary, onClose, onChanged }: Omit<Props, 'open'>) {
  const [input, setInput] = useState('');
  const [inputInvalid, setInputInvalid] = useState(false);
  const [term, setTerm] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const search = useBorrowerCandidates(applicationId, term);

  const candidates = search.data ?? [];
  // Нэг үр дүн байвал шууд сонгогдоно.
  const selected = candidates.find((c) => c.customerId === pickedId) ?? (candidates.length === 1 ? candidates[0] : null);

  const submitSearch = () => {
    const normalized = normalizeRegisterNo(input);
    if (!isSearchableRegisterNo(normalized)) {
      setInputInvalid(true);
      return;
    }
    setInputInvalid(false);
    setPickedId(null);
    if (normalized === term) void search.refetch();
    else setTerm(normalized);
  };

  return (
    <Flex vertical gap={16}>
      <div>
        <Typography.Text strong>{t('borrower.add.searchLabel')}</Typography.Text>
        <Input.Search
          style={{ marginTop: 8 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onSearch={submitSearch}
          placeholder={t('borrower.add.searchPlaceholder')}
          enterButton={t('borrower.add.searchButton')}
          loading={search.isFetching}
          status={inputInvalid ? 'error' : undefined}
          maxLength={REGISTER_MAX_LENGTH * 2}
          allowClear
          autoFocus
        />
        {inputInvalid ? <Typography.Text type="danger">{t('borrower.add.searchInvalid')}</Typography.Text> : null}
      </div>

      {term === null ? (
        <Typography.Text type="secondary">{t('borrower.add.searchHint')}</Typography.Text>
      ) : search.isPending ? (
        <Skeleton active paragraph={{ rows: 2 }} />
      ) : search.isError ? (
        <ApiErrorAlert error={search.error} onRetry={() => void search.refetch()} />
      ) : candidates.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Flex vertical>
              <Typography.Text>{t('borrower.add.notFound')}</Typography.Text>
              <Typography.Text type="secondary">{t('borrower.add.notFoundHint')}</Typography.Text>
            </Flex>
          }
        />
      ) : (
        <Flex vertical gap={8}>
          <Typography.Text strong>{t('borrower.add.found')}</Typography.Text>
          {candidates.map((c) => (
            <CandidateCard key={c.customerId} candidate={c} selected={selected?.customerId === c.customerId} onSelect={() => setPickedId(c.customerId)} />
          ))}
        </Flex>
      )}

      {selected ? (
        <AddBorrowerForm key={selected.customerId} applicationId={applicationId} candidate={selected} items={items} summary={summary} onClose={onClose} onChanged={onChanged} />
      ) : null}
    </Flex>
  );
}

function CandidateCard({ candidate, selected, onSelect }: { candidate: BorrowerCandidate; selected: boolean; onSelect: () => void }) {
  const { token } = theme.useToken();
  return (
    <Card size="small" style={selected ? { borderColor: token.colorPrimary } : undefined}>
      <Flex justify="space-between" align="center" gap={12}>
        <Flex vertical gap={2}>
          <Flex align="center" gap={8} wrap>
            <Typography.Text strong>{candidate.displayName}</Typography.Text>
            <Tag>{t(customerTypeKey(candidate.customerType))}</Tag>
          </Flex>
          <Typography.Text type="secondary">
            {candidate.registerNoMasked}
            {candidate.phone ? ` · ${candidate.phone}` : ''}
          </Typography.Text>
          {candidate.linkedRoles.length > 0 ? (
            <Flex align="center" gap={4} wrap>
              <Typography.Text type="secondary">{t('borrower.add.currentRoles')}</Typography.Text>
              {candidate.linkedRoles.map((r) => (
                <Tag key={r} color={ROLE_COLOR[r]}>{t(roleKey(r))}</Tag>
              ))}
            </Flex>
          ) : null}
        </Flex>
        <Button type={selected ? 'primary' : 'default'} ghost={selected} onClick={onSelect} disabled={selected}>
          {selected ? t('borrower.add.selected') : t('borrower.add.select')}
        </Button>
      </Flex>
    </Card>
  );
}

interface FormProps {
  applicationId: string;
  candidate: BorrowerCandidate;
  items: readonly BorrowerView[];
  summary: BorrowerSummary;
  onClose: () => void;
  onChanged?: () => void;
}

function AddBorrowerForm({ applicationId, candidate, items, summary, onClose, onChanged }: FormProps) {
  const options = candidateRoleOptions(candidate, summary);
  const initialRole = firstEnabledRole(options);

  if (!initialRole) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t('borrower.add.noRoles')}
        description={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {options.map((o) => (
              <li key={o.role}>
                {t(roleKey(o.role))}: {o.reason ? t(o.reason.key, o.reason.params) : ''}
              </li>
            ))}
          </ul>
        }
      />
    );
  }
  return <AddBorrowerFormInner applicationId={applicationId} candidate={candidate} items={items} options={options} initialRole={initialRole} onClose={onClose} onChanged={onChanged} />;
}

interface InnerProps extends Omit<FormProps, 'summary'> {
  options: RoleOption[];
  initialRole: BorrowerRole;
}

function AddBorrowerFormInner({ applicationId, candidate, items, options, initialRole, onClose, onChanged }: InnerProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<BorrowerFormValues>();
  const role = Form.useWatch('role', form);
  const guaranteeType = Form.useWatch('guaranteeType', form);
  const add = useAddBorrower(applicationId, onChanged);

  const onFinish = (values: BorrowerFormValues) => {
    const body = buildAddRequest(candidate.customerId, values);
    if (!body) return;
    add.mutate(body, {
      onSuccess: () => {
        void message.success(t('borrower.toast.added', { name: candidate.displayName }));
        onClose();
      },
    });
  };

  return (
    <Form<BorrowerFormValues>
      form={form}
      layout="vertical"
      requiredMark="optional"
      initialValues={{ role: initialRole, ...roleDefaults(initialRole) }}
      onValuesChange={(changed) => {
        if (changed.role) form.setFieldsValue(roleDefaults(changed.role)); // дүр солиход талбаруудыг анхдагчид буцаана
      }}
      onFinish={onFinish}
    >
      <Form.Item
        name="role"
        label={t('borrower.form.role')}
        rules={[{ required: true, message: t('borrower.form.roleRequired') }]}
        extra={role ? t(roleHintKey(role)) : undefined}
      >
        <Select
          placeholder={t('borrower.form.rolePlaceholder')}
          options={options.map((o) => ({ value: o.role, label: t(roleKey(o.role)), disabled: o.reason !== null }))}
          // Хаалттай дүрийн шалтгааныг жагсаалтад харуулна; сонгосон утга үргэлж зөвхөн дүрийн нэр.
          optionRender={(option) => {
            const reason = options.find((o) => o.role === option.value)?.reason;
            if (!reason) return option.label;
            return (
              <Flex vertical>
                <span>{option.label}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'normal' }}>{t(reason.key, reason.params)}</Typography.Text>
              </Flex>
            );
          }}
        />
      </Form.Item>

      <BorrowerFormFields role={role} guaranteeType={guaranteeType} remainingPercent={remainingSharePercent(items)} />

      {add.error ? (
        <div style={{ marginBottom: 16 }}>
          <ApiErrorAlert error={add.error} />
        </div>
      ) : null}
      <Flex justify="end" gap={8}>
        <Button onClick={onClose}>{t('borrower.action.cancel')}</Button>
        <Button type="primary" htmlType="submit" loading={add.isPending}>{t('borrower.add.submit')}</Button>
      </Flex>
    </Form>
  );
}
