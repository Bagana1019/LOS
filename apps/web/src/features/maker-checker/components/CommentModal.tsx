'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Form, Input, Modal, Typography } from 'antd';
import { mn } from '@los/ui';
import { COMMENT_MAX, COMMENT_MIN, textErrorMessage, validateText } from '../validation';

export interface CommentModalProps {
  open: boolean;
  title: string;
  hint?: ReactNode;
  label: string;
  placeholder: string;
  okText: string;
  okDanger?: boolean;
  /** Required comments need at least COMMENT_MIN characters; optional ones may stay empty. */
  required: boolean;
  loading: boolean;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}

/** Modal with one comment textarea; the OK button stays disabled until the text is valid. */
export function CommentModal({ open, title, hint, label, placeholder, okText, okDanger, required, loading, onSubmit, onCancel }: CommentModalProps) {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const rules = { required, min: required ? COMMENT_MIN : 0, max: COMMENT_MAX };
  const error = validateText(value, rules);

  useEffect(() => {
    if (open) {
      setValue('');
      setTouched(false);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      title={title}
      okText={okText}
      cancelText={mn['maker_checker.btn.dismiss']}
      okButtonProps={{ danger: okDanger, disabled: error !== null, loading }}
      cancelButtonProps={{ disabled: loading }}
      onOk={() => onSubmit(value.trim())}
      onCancel={onCancel}
      maskClosable={!loading}
      keyboard={!loading}
      destroyOnHidden
    >
      {hint && <Typography.Paragraph type="secondary">{hint}</Typography.Paragraph>}
      <Form layout="vertical">
        <Form.Item
          label={label}
          required={required}
          validateStatus={touched && error ? 'error' : undefined}
          help={touched && error ? textErrorMessage(error, rules) : undefined}
        >
          <Input.TextArea
            value={value}
            rows={4}
            maxLength={COMMENT_MAX}
            showCount
            autoFocus
            placeholder={placeholder}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
            }}
            onBlur={() => setTouched(true)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
