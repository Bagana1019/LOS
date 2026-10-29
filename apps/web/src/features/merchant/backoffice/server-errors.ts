import type { FormInstance } from 'antd';
import { t } from '../../../lib/i18n';
import { errorMessage, fieldIssues } from '../errors';
import { isApiError } from '../../../lib/merchant-api';

/** VALIDATION_FAILED / DUPLICATE_CODE-г формын талбарт тусгана. Буцаах утга: нийтлэг (талбарт хамааралгүй) мессеж, эсвэл null. */
export function applyServerErrors(form: FormInstance, e: unknown, duplicateField: string | string[] = 'code'): string | null {
  if (isApiError(e) && e.code === 'DUPLICATE_CODE') {
    form.setFields([{ name: duplicateField, errors: [errorMessage(e)] }]);
    return null;
  }
  const issues = fieldIssues(e);
  if (issues.length > 0) {
    form.setFields(issues.map((i) => ({ name: i.path, errors: [t('validation.invalid')] })));
    return t('backoffice.fixFields');
  }
  return errorMessage(e);
}
