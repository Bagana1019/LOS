'use client';
import { Alert } from 'antd';
import type { Feedback } from './bsa.feedback';

/** Үр дүнгийн мэдэгдэл: гол мөр + (байвал) файл бүрийн тайлбар. Хаах хүртэл эсвэл дараагийн үйлдэл хүртэл үлдэнэ (toast шиг алга болохгүй). */
export function FeedbackAlert({ feedback, onClose }: { feedback: Feedback; onClose: () => void }) {
  return (
    <Alert
      type={feedback.type}
      showIcon
      closable
      onClose={onClose}
      style={{ marginTop: 12 }}
      message={feedback.message}
      description={feedback.details.length > 0
        ? <ul style={{ margin: 0, paddingLeft: 20 }}>{feedback.details.map((d, i) => <li key={`${i}:${d}`}>{d}</li>)}</ul>
        : undefined}
    />
  );
}
