import type { FormInstance } from 'antd';
import type { FieldError } from './collateral.form';

type FieldData<V> = Parameters<FormInstance<V>['setFields']>[0];

/** Дүрмийн (zod) алдааг antd формын талбарт буулгаад эхний алдаатай талбар руу гүйлгэнэ. */
export function applyFieldErrors<V>(form: FormInstance<V>, errors: readonly FieldError[]): void {
  form.setFields(errors.map((e) => ({ name: e.name, errors: [e.message] })) as FieldData<V>);
  const first = errors[0];
  if (first) form.scrollToField(first.name as unknown as Parameters<FormInstance<V>['scrollToField']>[0], { block: 'center' });
}
