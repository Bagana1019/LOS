'use client';
import { Alert, App, Button, Descriptions, Flex, Form, Input, Radio, Typography } from 'antd';
import type { AmlHitReviewRequest } from '@los/contracts';
import { t } from '../../lib/i18n';
import { reviewConfirmCopy, validateReviewReason } from './aml.utils';

export interface AmlReviewFormProps {
  hitId: string;
  /** Жагсаалтын бүртгэлийн нэр — баталгаажуулах цонхонд "юуг шийдэж байгаа"-г харуулна. */
  hitName: string;
  /** Шалгагдсан харилцагчийн нэр. */
  customerName: string;
  submitting: boolean;
  onSubmit: (hitId: string, body: AmlHitReviewRequest) => void;
}

const DECISIONS: readonly AmlHitReviewRequest['decision'][] = ['FALSE_POSITIVE', 'CONFIRMED'];

/** Нэг hit-ийн шийдвэр (§5): жинхэнэ / худал тохирол + заавал тайлбар. Шийдвэр буцаагдахгүй тул хадгалахаас өмнө баталгаажуулна (F7-2). */
export function AmlReviewForm({ hitId, hitName, customerName, submitting, onSubmit }: AmlReviewFormProps) {
  const [form] = Form.useForm<{ decision?: AmlHitReviewRequest['decision']; comment: string }>();
  const { modal } = App.useApp();

  const confirmSave = (body: AmlHitReviewRequest) => {
    const copy = reviewConfirmCopy(body.decision);
    modal.confirm({
      title: t('aml.review.confirmTitle'),
      content: (
        <Flex vertical gap={12}>
          <Descriptions size="small" column={1}>
            <Descriptions.Item label={t('aml.hit.customer')}>{customerName}</Descriptions.Item>
            <Descriptions.Item label={t('aml.hit.entry')}>{hitName}</Descriptions.Item>
            <Descriptions.Item label={t('aml.review.decision')}><Typography.Text strong>{copy.decision}</Typography.Text></Descriptions.Item>
          </Descriptions>
          <Alert type="warning" showIcon message={t('aml.review.confirmFinal')} description={copy.consequence} />
        </Flex>
      ),
      okText: t('aml.review.confirmOk'),
      cancelText: t('aml.review.confirmCancel'),
      onOk: () => onSubmit(hitId, body),
    });
  };

  return (
    <div data-testid={`aml-review-${hitId}`}>
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => v.decision && confirmSave({ decision: v.decision, comment: v.comment.trim() })}
      >
        <Form.Item name="decision" label={t('aml.review.decision')} rules={[{ required: true, message: t('aml.review.decisionRequired') }]}>
          <Radio.Group>
            {DECISIONS.map((d) => <Radio key={d} value={d}>{t(`aml.review.${d}`)}</Radio>)}
          </Radio.Group>
        </Form.Item>
        <Form.Item
          name="comment"
          label={t('aml.review.reason')}
          required
          rules={[{ validator: (_, value: string | undefined) => { const err = validateReviewReason(value ?? ''); return err ? Promise.reject(new Error(err)) : Promise.resolve(); } }]}
        >
          <Input.TextArea rows={3} maxLength={2000} showCount placeholder={t('aml.review.reasonPlaceholder')} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting}>{t('aml.review.submit')}</Button>
      </Form>
    </div>
  );
}
