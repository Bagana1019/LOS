'use client';
import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Flex, Input, Radio, Skeleton, Typography } from 'antd';
import { ContractNumberTemplateBody } from '@los/contracts';
import { t } from '../../lib/i18n';
import { errorText, previewContractNo } from './admin.utils';
import { useSaveTemplate, useTemplate } from './admin.hooks';
import { BackLink } from './SettingsHome';

type Scope = 'DAY' | 'BRANCH' | 'GLOBAL';

/** BR-11 · Гэрээний дугаарын загвар. Дугаар батлагдах үед origination үүсгэнэ; энд зөвхөн загвар. */
export function ContractNumberPage() {
  const { message } = App.useApp();
  const tpl = useTemplate();
  const save = useSaveTemplate();
  const [pattern, setPattern] = useState('');
  const [prefix, setPrefix] = useState('');
  const [scope, setScope] = useState<Scope>('DAY');
  useEffect(() => { if (tpl.data) { setPattern(tpl.data.pattern); setPrefix(tpl.data.prefix); setScope(tpl.data.seqScope); } }, [tpl.data]);

  const parsed = ContractNumberTemplateBody.safeParse({ pattern, prefix, seqScope: scope });
  const issue = parsed.success ? null : parsed.error.issues[0]?.message ?? null;
  const onSave = () => parsed.success && save.mutate(parsed.data, { onSuccess: () => void message.success(t('admin.template.saved')), onError: (e) => void message.error(errorText(e)) });

  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.template.title')}</Typography.Title>
      <Alert type="info" showIcon message={t('admin.template.hint')} />
      {tpl.isError ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(tpl.error)} /> : tpl.isLoading ? <Skeleton active /> : (
        <Card style={{ maxWidth: 640 }}>
          <Flex vertical gap={12}>
            <label>{t('admin.template.pattern')}<Input value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={80} /></label>
            <label>{t('admin.template.prefix')}<Input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={12} /></label>
            <div>
              <div>{t('admin.template.scope')}</div>
              <Radio.Group value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
                <Flex vertical>{(['DAY', 'BRANCH', 'GLOBAL'] as const).map((s) => <Radio key={s} value={s}>{t(`admin.template.scope.${s}`)}</Radio>)}</Flex>
              </Radio.Group>
            </div>
            {issue ? <Alert type="error" showIcon message={issue} /> : (
              <Typography.Text>{t('admin.template.preview')}: <Typography.Text code>{previewContractNo(pattern, prefix, '100', new Date(), 1)}</Typography.Text></Typography.Text>
            )}
            <div><Button type="primary" onClick={onSave} loading={save.isPending} disabled={!parsed.success}>{t('admin.common.save')}</Button></div>
          </Flex>
        </Card>
      )}
    </Flex>
  );
}
