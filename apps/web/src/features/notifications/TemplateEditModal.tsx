'use client';
import { useMemo, useRef, useState } from 'react';
import { App as AntApp, Alert, Button, Col, Flex, Form, Input, Modal, Row, Switch, Tag, Tooltip, Typography } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import type { TemplatePlaceholder, TemplateView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { NotificationErrorAlert } from './NotificationErrorAlert';
import { TemplatePreview } from './TemplatePreview';
import {
  CHANNEL_COLOR, PLACEHOLDERS, TEMPLATE_BODY_MAX, buildPreviewRequest, buildUpsertRequest, channelKey, channelUsesSubject, formFromTemplate,
  insertPlaceholder, isTemplateDirty, placeholderKey, templateSource, templateTarget, typeKey, validateTemplateForm, type FieldError, type TemplateFormValues,
} from './notifications.utils';
import { useTemplatePreview, useUpsertTemplate } from './useNotificationAdmin';
import { useDebouncedValue } from './useDebouncedValue';

interface Props {
  template: TemplateView;
  onClose: () => void;
}

const PREVIEW_DEBOUNCE_MS = 400;

const help = (errors: readonly FieldError[], field: FieldError['field']) => {
  const list = errors.filter((e) => e.field === field);
  return list.length > 0 ? list.map((e) => t(e.key, e.params)).join(' · ') : undefined;
};

/** Загвар засах (ADMIN): гарчиг, агуулга, идэвхтэй эсэх + placeholder оруулах + серверээс урьдчилан харах. Модалыг нээх бүрд шинээр mount хийнэ. */
export function TemplateEditModal({ template, onClose }: Props) {
  const { message } = AntApp.useApp();
  const target = useMemo(() => templateTarget(template), [template]);
  const initial = useMemo(() => formFromTemplate(template), [template]);
  const [values, setValues] = useState<TemplateFormValues>(initial);
  const bodyRef = useRef<TextAreaRef>(null);
  const upsert = useUpsertTemplate();

  const usesSubject = channelUsesSubject(target.channel);
  const errors = validateTemplateForm(target.channel, values);
  const dirty = isTemplateDirty(initial, values);
  const isOverride = templateSource(template) !== 'BUILTIN';

  const debounced = useDebouncedValue(values, PREVIEW_DEBOUNCE_MS);
  const previewRequest = useMemo(() => buildPreviewRequest(target, debounced), [target, debounced]);
  const preview = useTemplatePreview(previewRequest);

  const set = (patch: Partial<TemplateFormValues>) => setValues((v) => ({ ...v, ...patch }));

  const onInsert = (name: TemplatePlaceholder) => {
    const el = bodyRef.current?.resizableTextArea?.textArea;
    const next = insertPlaceholder(values.body, el?.selectionStart ?? values.body.length, el?.selectionEnd ?? values.body.length, name);
    set({ body: next.text });
    // React шинэ утгыг DOM-д бичсний дараа курсорыг оруулсан placeholder-ийн ард тавина.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  const onSave = () => {
    if (errors.length > 0 || !dirty) return;
    upsert.mutate(buildUpsertRequest(target, values), {
      onSuccess: () => {
        void message.success(t('notification.templates.saved'));
        onClose();
      },
    });
  };

  return (
    <Modal
      open
      width={920}
      maskClosable={false}
      onCancel={onClose}
      title={
        <Flex gap={8} align="center" wrap>
          <span>{t('notification.templates.modalTitle')}</span>
          <Tag>{t(typeKey(template.type))}</Tag>
          <Tag color={CHANNEL_COLOR[template.channel]}>{t(channelKey(template.channel))}</Tag>
        </Flex>
      }
      footer={[
        <Button key="cancel" onClick={onClose}>{t('notification.common.cancel')}</Button>,
        <Button key="save" type="primary" loading={upsert.isPending} disabled={errors.length > 0 || !dirty} onClick={onSave}>{t('notification.common.save')}</Button>,
      ]}
    >
      <Row gutter={24}>
        <Col xs={24} lg={13}>
          <Flex vertical gap={12}>
            {upsert.isError ? <NotificationErrorAlert error={upsert.error} title={t('notification.templates.saveError')} /> : null}
            {!isOverride ? <Alert type="info" showIcon message={t('notification.templates.builtinHint')} /> : null}

            <Form layout="vertical" requiredMark={false}>
              <Form.Item label={t('notification.templates.field.locale')}>
                <Typography.Text>{template.locale}</Typography.Text>
              </Form.Item>

              {usesSubject ? (
                <Form.Item
                  label={t('notification.templates.field.subject')}
                  required
                  validateStatus={help(errors, 'subject') ? 'error' : undefined}
                  help={help(errors, 'subject')}
                >
                  <Input value={values.subject} onChange={(e) => set({ subject: e.target.value })} showCount aria-label={t('notification.templates.field.subject')} />
                </Form.Item>
              ) : (
                <Typography.Paragraph type="secondary">{t('notification.templates.smsNoSubject')}</Typography.Paragraph>
              )}

              <Form.Item
                label={t('notification.templates.field.body')}
                required
                validateStatus={help(errors, 'body') ? 'error' : undefined}
                help={help(errors, 'body')}
              >
                <Input.TextArea
                  ref={bodyRef}
                  rows={9}
                  value={values.body}
                  onChange={(e) => set({ body: e.target.value })}
                  showCount={{ formatter: ({ count }) => `${count} / ${TEMPLATE_BODY_MAX}` }}
                  aria-label={t('notification.templates.field.body')}
                />
              </Form.Item>

              <Form.Item label={t('notification.templates.placeholders.title')}>
                <Flex gap={6} wrap>
                  {PLACEHOLDERS.map((name) => (
                    <Tooltip key={name} title={t(placeholderKey(name))}>
                      <Tag.CheckableTag checked={false} onChange={() => onInsert(name)} style={{ border: '1px dashed rgba(128,128,128,0.6)', cursor: 'pointer' }}>
                        {`{{${name}}}`}
                      </Tag.CheckableTag>
                    </Tooltip>
                  ))}
                </Flex>
                <Typography.Text type="secondary">{t('notification.templates.placeholders.hint')}</Typography.Text>
              </Form.Item>

              <Form.Item label={t('notification.templates.field.active')} extra={t('notification.templates.field.activeHint')}>
                <Switch checked={values.isActive} onChange={(isActive) => set({ isActive })} />
              </Form.Item>
            </Form>
          </Flex>
        </Col>

        <Col xs={24} lg={11}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>{t('notification.templates.preview.title')}</Typography.Title>
          <Typography.Paragraph type="secondary">{t('notification.templates.preview.hint')}</Typography.Paragraph>
          <TemplatePreview channel={target.channel} disabled={previewRequest === null} loading={preview.isFetching} error={preview.error} data={preview.data} />
        </Col>
      </Row>
    </Modal>
  );
}
