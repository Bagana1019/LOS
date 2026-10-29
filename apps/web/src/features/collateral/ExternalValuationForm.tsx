'use client';
import { useState } from 'react';
import { App as AntApp, Alert, Button, Flex, Form, Input, InputNumber, Typography } from 'antd';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { FileUploadButton } from '../documents/shared/FileUploadButton';
import { formatBytes, uploadDmsFile, type DmsFile } from '../documents/shared/files';
import { buildExternalValuationRequest, type ExternalValuationFormValues } from './collateral.utils';
import { applyFieldErrors } from './form-errors';
import { MONEY_INPUT_PROPS } from './money-input';
import type { TabProps } from './TabProps';
import { useRecordExternalValuation } from './useCollateral';
import { canWriteBlocked } from './write-gates';

/** FR-14.3: гадны лицензтэй үнэлгээчний үнэлгээ — тайлангийн файл (dms) заавал. Файлыг сонгоход шууд dms-д байршуулж, дараа нь үнэлгээнд холбоно. */
export function ExternalValuationForm({ applicationId, item, write, onChanged }: TabProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<ExternalValuationFormValues>();
  const record = useRecordExternalValuation(applicationId, onChanged);
  const [report, setReport] = useState<DmsFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const gate = canWriteBlocked(write);
  const required = item.valuation?.externalRequired && !item.valuation.externalSatisfied;

  const onFile = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      setReport(await uploadDmsFile(file));
      setReportError(null);
    } catch (e) {
      setUploadError(e);
    } finally {
      setUploading(false);
    }
  };

  const onFinish = (values: ExternalValuationFormValues) => {
    const built = buildExternalValuationRequest(values, report?.id);
    if (!built.ok) {
      const reportIssue = built.errors.find((e) => e.name[0] === 'reportFileId');
      setReportError(reportIssue?.message ?? null);
      applyFieldErrors(form, built.errors.filter((e) => e.name[0] !== 'reportFileId'));
      return;
    }
    setReportError(null);
    record.mutate(
      { collateralId: item.id, body: built.body },
      {
        onSuccess: () => {
          void message.success(t('collateral.toast.externalSaved'));
          form.resetFields();
          setReport(null);
        },
      },
    );
  };

  return (
    <Form<ExternalValuationFormValues> name={`collateral-external-${item.id}`} form={form} layout="vertical" requiredMark="optional" onFinish={onFinish} data-testid="external-valuation">
      {required ? <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t('collateral.valuation.externalRequiredAlert')} /> : null}
      <Typography.Paragraph type="secondary">{t('collateral.valuation.externalNote')}</Typography.Paragraph>
      <Flex gap={16} wrap>
        <Form.Item name="appraiser" label={t('collateral.external.appraiser')} required style={{ flex: '1 1 260px' }}>
          <Input maxLength={200} autoComplete="off" />
        </Form.Item>
        <Form.Item name="licenseNo" label={t('collateral.external.licenseNo')} extra={t('collateral.external.licenseNoHint')} style={{ flex: '1 1 200px' }}>
          <Input maxLength={60} autoComplete="off" />
        </Form.Item>
      </Flex>
      <Flex gap={16} wrap>
        <Form.Item name="valuedAt" label={t('collateral.external.valuedAt')} required style={{ flex: '1 1 180px' }}>
          <Input type="date" />
        </Form.Item>
        <Form.Item name="validUntil" label={t('collateral.external.validUntil')} extra={t('collateral.external.validUntilHint')} style={{ flex: '1 1 180px' }}>
          <Input type="date" />
        </Form.Item>
        <Form.Item name="marketValue" label={t('collateral.external.marketValue')} required style={{ flex: '1 1 240px' }}>
          <InputNumber<number> {...MONEY_INPUT_PROPS} />
        </Form.Item>
      </Flex>
      <Form.Item label={t('collateral.external.report')} required validateStatus={reportError ? 'error' : undefined} help={reportError ?? t('collateral.external.reportHint')}>
        <Flex gap={12} align="center" wrap>
          <FileUploadButton label={t('collateral.external.reportUpload')} loading={uploading} disabled={gate.disabled} onFile={(f) => void onFile(f)} />
          {report ? (
            <Typography.Text data-testid="external-report-name">
              {report.name} ({formatBytes(report.size)})
            </Typography.Text>
          ) : null}
        </Flex>
        <div style={{ marginTop: 8 }}><ApiErrorAlert error={uploadError} scope="collateral" /></div>
      </Form.Item>
      <Form.Item name="note" label={t('collateral.external.note')}>
        <Input.TextArea rows={2} maxLength={500} showCount />
      </Form.Item>
      <ApiErrorAlert error={record.error} scope="collateral" />
      <div style={{ marginTop: record.error ? 12 : 0 }}>
        <Button type="primary" htmlType="submit" loading={record.isPending} disabled={gate.disabled || uploading} title={gate.text}>{t('collateral.external.save')}</Button>
      </div>
    </Form>
  );
}
