'use client';
import { Alert } from 'antd';
import { mn } from '@los/ui';
import type { RangeWarning } from '../range-warnings';

/** F9-5: non-blocking notice for values outside the sane ranges. The checker can still approve - this only asks for a second look. */
export function RangeWarningsAlert({ warnings }: { warnings: readonly RangeWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert
      data-testid="mc-range-warnings"
      type="warning"
      showIcon
      message={mn['maker_checker.warn.title']}
      description={
        <>
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            {warnings.map((w) => (
              <li key={w.path}>{w.message}</li>
            ))}
          </ul>
          <div>{mn['maker_checker.warn.hint']}</div>
        </>
      }
    />
  );
}
