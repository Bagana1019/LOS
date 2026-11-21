'use client';
import { Flex, Typography } from 'antd';
import { CONTRACT_NUMBER_TOKENS } from '@los/contracts';
import { t } from '../../lib/i18n';
import { previewContractNo } from './admin.utils';

/** Seed-ийн анхдагч загвартай ижил. Жишээ дугаар: угтвар B, салбарын код 100, өнөөдөр, 1-р дугаар. */
const EXAMPLE_PATTERN = '{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}';

/** F9-21: загварын талбарын доор дэмжигдэх хэсгүүд (validator-той ижил жагсаалт) ба нэг жишээ. */
export function ContractNumberTokenHelp() {
  const title = t('admin.template.tokens.title');
  return (
    <Flex vertical gap={4}>
      <Typography.Text type="secondary">{title}</Typography.Text>
      <ul aria-label={title} style={{ margin: 0, paddingLeft: 20 }}>
        {CONTRACT_NUMBER_TOKENS.map(({ token, label }) => (
          <li key={token}><Typography.Text code>{token}</Typography.Text> — {label}</li>
        ))}
      </ul>
      <Typography.Text data-testid="contract-number-example">
        {t('admin.template.tokens.example')}: <Typography.Text code>{EXAMPLE_PATTERN}</Typography.Text> → <Typography.Text code>{previewContractNo(EXAMPLE_PATTERN, 'B', '100', new Date(), 1)}</Typography.Text>
      </Typography.Text>
    </Flex>
  );
}
