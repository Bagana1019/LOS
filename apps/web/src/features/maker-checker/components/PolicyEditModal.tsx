'use client';
import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, InputNumber, Modal, Select, Switch, Tooltip } from 'antd';
import { mn } from '@los/ui';
import type { MakerCheckerPolicyDto } from '@los/contracts';
import { useUpdatePolicy } from '../hooks';
import { CHECKER_ROLES, describeChange, fmt, roleLabel, type CheckerRole } from '../labels';
import { COMMENT_MIN, EXPIRES_MAX, EXPIRES_MIN, textErrorMessage, validateText } from '../validation';

interface FormValues {
  enabled: boolean;
  checkerRoles: CheckerRole[];
  expiresInHours: number | null;
  reason: string;
}

interface Props {
  policy: MakerCheckerPolicyDto;
  /** Value the switch was toggled to in the table, if the edit started there. */
  presetEnabled?: boolean;
  onClose: () => void;
  /** Called after the server accepted the change; `requestId` is the change request to follow. */
  onOpenRequest: (requestId: string) => void;
}

const reasonRules = { required: true, min: COMMENT_MIN } as const;

/** Edit a policy. Needs a reason; the change is submitted as a request that another admin must approve. */
export function PolicyEditModal({ policy, presetEnabled, onClose, onOpenRequest }: Props) {
  const [form] = Form.useForm<FormValues>();
  const { notification } = App.useApp();
  const update = useUpdatePolicy();
  const [valid, setValid] = useState(false);
  const values = Form.useWatch([], form);
  const { title } = describeChange(policy.targetType, policy.action);

  // Submit stays disabled until every field validates.
  useEffect(() => {
    form.validateFields({ validateOnly: true }).then(
      () => setValid(true),
      () => setValid(false),
    );
  }, [form, values]);

  const onFinish = async (v: FormValues) => {
    try {
      const { outcome, request } = await update.mutateAsync({
        targetType: policy.targetType,
        action: policy.action,
        update: {
          // A locked policy can never be switched off.
          enabled: policy.locked ? true : v.enabled,
          checkerRoles: v.checkerRoles,
          expiresInHours: v.expiresInHours as number,
          reason: v.reason,
        },
      });
      onClose();
      if (outcome === 'PENDING') {
        notification.success({
          message: mn['maker_checker.policies.success_pending'],
          description: mn['maker_checker.policies.success_pending_desc'],
          duration: 8,
          btn: (
            <Button size="small" type="link" onClick={() => onOpenRequest(request.id)}>
              {mn['maker_checker.policies.view_request']}
            </Button>
          ),
        });
      } else {
        notification.success({ message: mn['maker_checker.policies.success_direct'] });
      }
    } catch {
      // The error message was already shown by useUpdatePolicy; keep the form open for another try.
    }
  };

  return (
    <Modal
      open
      title={fmt(mn['maker_checker.policies.edit_title'], { name: `${title} (${policy.targetType} / ${policy.action})` })}
      okText={mn['maker_checker.policies.submit']}
      cancelText={mn['maker_checker.btn.dismiss']}
      okButtonProps={{ disabled: !valid, loading: update.isPending }}
      cancelButtonProps={{ disabled: update.isPending }}
      onOk={() => form.submit()}
      onCancel={onClose}
      maskClosable={!update.isPending}
      keyboard={!update.isPending}
      closable={!update.isPending}
      width={560}
    >
      <Alert type="info" showIcon message={mn['maker_checker.policies.notice']} style={{ marginBottom: 16 }} />
      <Form<FormValues>
        form={form}
        layout="vertical"
        disabled={update.isPending}
        initialValues={{
          enabled: policy.locked ? true : (presetEnabled ?? policy.enabled),
          checkerRoles: policy.checkerRoles,
          expiresInHours: policy.expiresInHours,
          reason: '',
        }}
        onFinish={onFinish}
      >
        <Form.Item name="enabled" label={mn['maker_checker.policies.field_enabled']} valuePropName="checked">
          <LockedSwitch locked={policy.locked} />
        </Form.Item>
        <Form.Item
          name="checkerRoles"
          label={mn['maker_checker.policies.field_roles']}
          rules={[{ required: true, type: 'array', min: 1, message: mn['maker_checker.policies.field_roles_required'] }]}
        >
          <Select<CheckerRole[]>
            mode="multiple"
            placeholder={mn['maker_checker.policies.field_roles_placeholder']}
            options={CHECKER_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </Form.Item>
        <Form.Item
          name="expiresInHours"
          label={mn['maker_checker.policies.field_expires']}
          required
          extra={mn['maker_checker.policies.field_expires_help']}
          rules={[
            {
              validator: (_, v: unknown) =>
                typeof v === 'number' && Number.isInteger(v) && v >= EXPIRES_MIN && v <= EXPIRES_MAX
                  ? Promise.resolve()
                  : Promise.reject(new Error(mn['maker_checker.policies.field_expires_invalid'])),
            },
          ]}
        >
          <InputNumber min={EXPIRES_MIN} max={EXPIRES_MAX} precision={0} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item
          name="reason"
          label={mn['maker_checker.policies.field_reason']}
          validateTrigger={['onChange', 'onBlur']}
          rules={[
            {
              validator: (_, v: string | undefined) => {
                const err = validateText(v ?? '', reasonRules);
                return err ? Promise.reject(new Error(textErrorMessage(err, reasonRules))) : Promise.resolve();
              },
            },
          ]}
          required
        >
          <Input.TextArea
            rows={3}
            showCount
            maxLength={2000}
            placeholder={fmt(mn['maker_checker.policies.field_reason_placeholder'], { min: COMMENT_MIN })}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Switch for Form.Item; a locked policy shows it disabled with an explanation. */
function LockedSwitch({ locked, checked, onChange }: { locked: boolean; checked?: boolean; onChange?: (v: boolean) => void }) {
  const sw = <Switch checked={checked} onChange={onChange} disabled={locked ? true : undefined} />;
  if (!locked) return sw;
  return (
    <Tooltip title={mn['maker_checker.policies.locked_tooltip']}>
      <span style={{ display: 'inline-block' }}>{sw}</span>
    </Tooltip>
  );
}
