'use client';
import { useState } from 'react';
import Link from 'next/link';
import { App as AntApp, Alert, Button, Flex, Form, Input, Modal, Select, Tag, Tooltip, Typography } from 'antd';
import { AssetType, type CollateralCandidate, type CollateralView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { CollateralFormFields } from './CollateralFormFields';
import { XypAssetPicker } from './XypAssetPicker';
import { applyFieldErrors } from './form-errors';
import { buildCreateRequest, buildUpdateRequest, cleanDescription, defaultDescription, formValuesOf, type BuildResult, type CollateralFormValues } from './collateral.form';
import { assetTypeKey, defaultOwnerId, roleKey, stepHref, type OwnerOption } from './collateral.utils';
import { useCreateCollateral, useUpdateCollateral } from './useCollateral';

interface Props {
  open: boolean;
  mode: 'create' | 'edit';
  applicationId: string;
  /** edit горимд. */
  collateral: CollateralView | null;
  owners: readonly OwnerOption[];
  onClose: () => void;
  onChanged?: () => void;
}

/** Барьцаа нэмэх / засах (FR-6.1, FR-6.2): хөрөнгийн төрөл → төрлийн талбарууд, өмчлөгч (хүсэлтийн оролцогчоос), ХУР-аас сонгох (FR-6.3). */
export function CollateralFormModal({ open, mode, ...rest }: Props) {
  return (
    <Modal
      open={open}
      title={t(mode === 'create' ? 'collateral.form.createTitle' : 'collateral.form.editTitle')}
      onCancel={rest.onClose}
      footer={null}
      width={780}
      destroyOnHidden
      maskClosable={false}
      style={{ top: 24 }}
    >
      <FormBody mode={mode} {...rest} />
    </Modal>
  );
}

const ownerLabel = (o: OwnerOption): string => {
  const base = `${o.name} · ${o.registerMasked} · ${o.roles.map((r) => t(roleKey(r))).join(', ')}`;
  return o.eligible ? base : `${base} — ${t('collateral.form.ownerNotEligible')}`;
};

function FormBody({ mode, applicationId, collateral, owners, onClose, onChanged }: Omit<Props, 'open'>) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<CollateralFormValues>();
  const assetType = Form.useWatch('assetType', form);
  const ownerId = Form.useWatch('ownerCustomerId', form);
  const [xyp, setXyp] = useState<{ ref: string; label: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const create = useCreateCollateral(applicationId, onChanged);
  const update = useUpdateCollateral(applicationId, onChanged);
  const error = mode === 'create' ? create.error : update.error;
  const pending = create.isPending || update.isPending;

  const initialValues: CollateralFormValues = mode === 'edit' && collateral ? formValuesOf(collateral) : { ownerCustomerId: defaultOwnerId(owners), description: {} };

  const showErrors = (result: Extract<BuildResult<unknown>, { ok: false }>) => {
    applyFieldErrors(form, result.errors);
  };

  const onFinish = (values: CollateralFormValues) => {
    if (mode === 'create') {
      const built = buildCreateRequest(values, { source: xyp ? 'XYP' : 'MANUAL', xypRef: xyp?.ref });
      if (!built.ok) return showErrors(built);
      create.mutate(built.body, {
        onSuccess: () => {
          void message.success(t('collateral.toast.added'));
          onClose();
        },
      });
      return;
    }
    if (!collateral) return;
    const built = buildUpdateRequest(collateral, values);
    if (!built.ok) return showErrors(built);
    if (built.body === null) {
      onClose();
      return;
    }
    update.mutate(
      { collateralId: collateral.id, body: built.body },
      {
        onSuccess: () => {
          void message.success(t('collateral.toast.updated'));
          onClose();
        },
      },
    );
  };

  const pick = (c: CollateralCandidate) => {
    form.setFieldValue('assetType', c.assetType);
    form.setFieldValue('description', cleanDescription(c.assetType, c.description));
    setXyp({ ref: c.xypRef, label: c.label });
    setPickerOpen(false);
  };

  return (
    <Form<CollateralFormValues>
      name={mode === 'create' ? 'collateral-create' : 'collateral-edit'}
      form={form}
      layout="vertical"
      requiredMark="optional"
      preserve={false}
      initialValues={initialValues}
      onValuesChange={(changed) => {
        if (mode === 'create' && changed.assetType) {
          // Төрөл солиход өмнөх төрлийн талбар арилж (preserve=false), шинэ төрлийн анхдагч утга орно; ХУР-аас авсан холбоос хүчингүй
          form.setFieldValue('description', defaultDescription(changed.assetType));
          setXyp(null);
          setPickerOpen(false);
        }
      }}
      onFinish={onFinish}
    >
      {mode === 'edit' ? <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t('collateral.form.editWarning')} /> : null}

      <Form.Item name="assetType" label={t('collateral.form.assetType')} required>
        <Select
          disabled={mode === 'edit'}
          placeholder={t('collateral.form.choose')}
          options={AssetType.map((a) => ({ value: a, label: t(assetTypeKey(a)) }))}
        />
      </Form.Item>

      <Form.Item
        name="ownerCustomerId"
        label={t('collateral.form.owner')}
        required
        extra={
          <span>
            {t('collateral.form.ownerHint')}{' '}
            <Link href={stepHref(applicationId, 'client')}>{t('collateral.form.ownerRegisterLink')}</Link>
          </span>
        }
      >
        <Select
          showSearch
          optionFilterProp="label"
          placeholder={t('collateral.form.ownerPlaceholder')}
          notFoundContent={t('collateral.form.ownerEmpty')}
          options={owners.map((o) => ({ value: o.customerId, label: ownerLabel(o), disabled: !o.eligible }))}
        />
      </Form.Item>

      {mode === 'create' ? (
        <Flex vertical gap={8} style={{ marginBottom: 16 }}>
          <Flex gap={8} align="center" wrap>
            <Tooltip title={ownerId ? undefined : t('collateral.xyp.needOwner')}>
              <span>
                <Button onClick={() => setPickerOpen((v) => !v)} disabled={!ownerId} aria-expanded={pickerOpen}>{t('collateral.xyp.open')}</Button>
              </span>
            </Tooltip>
            {xyp ? (
              <Tag closable onClose={() => setXyp(null)} color="processing">{t('collateral.xyp.selected', { label: xyp.label })}</Tag>
            ) : (
              <Typography.Text type="secondary">{t('collateral.xyp.hint')}</Typography.Text>
            )}
          </Flex>
          {pickerOpen && ownerId ? <XypAssetPicker applicationId={applicationId} ownerCustomerId={ownerId} onPick={pick} onClose={() => setPickerOpen(false)} /> : null}
        </Flex>
      ) : null}

      <CollateralFormFields assetType={assetType} />

      {assetType ? (
        <>
          <Typography.Title level={5} style={{ marginTop: 8 }}>{t('collateral.form.extraTitle')}</Typography.Title>
          <Flex gap={16} wrap>
            <Form.Item name="registryNo" label={t('collateral.form.registryNo')} extra={t('collateral.form.registryNoHint')} style={{ flex: '1 1 240px' }}>
              <Input maxLength={100} autoComplete="off" />
            </Form.Item>
            <Form.Item name="registryDate" label={t('collateral.form.registryDate')} style={{ flex: '1 1 180px' }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="insuranceExpiresAt" label={t('collateral.form.insuranceExpiresAt')} style={{ flex: '1 1 180px' }}>
              <Input type="date" />
            </Form.Item>
          </Flex>
          <Form.Item name="note" label={t('collateral.form.note')}>
            <Input.TextArea rows={2} maxLength={1000} showCount />
          </Form.Item>
        </>
      ) : null}

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <ApiErrorAlert error={error} scope="collateral" />
        </div>
      ) : null}
      <Flex justify="end" gap={8}>
        <Button onClick={onClose}>{t('collateral.action.cancel')}</Button>
        <Button type="primary" htmlType="submit" loading={pending}>{t(mode === 'create' ? 'collateral.form.submitCreate' : 'collateral.form.submitEdit')}</Button>
      </Flex>
    </Form>
  );
}
