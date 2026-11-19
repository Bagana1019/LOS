'use client';
import { Button, Form, Input, Radio } from 'antd';
import type { AmlHitReviewRequest } from '@los/contracts';
import { t } from '../../lib/i18n';
import { validateReviewReason } from './aml.utils';

export interface AmlReviewFormProps {
  hitId: string;
  submitting: boolean;
  onSubmit: (hitId: string, body: AmlHitReviewRequest) => void;
}

const DECISIONS: readonly AmlHitReviewRequest['decision'][] = ['FALSE_POSITIVE', 'CONFIRMED'];

/** Нэг hit-ийн шийдвэр (§5): жинхэнэ / худал тохирол + заавал тайлбар. */
export function AmlReviewForm({ hitId, submitting, onSubmit }: AmlReviewFormProps) {
  const [form] = Form.useForm<{ decision?: AmlHitReviewRequest['decision']; comment: string }>();
  return (
    <div data-testid={`aml-review-${hitId}`}>
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => v.decision && onSubmit(hitId, { decision: v.decision, comment: v.comment.trim() })}
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
