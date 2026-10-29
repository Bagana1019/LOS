import type { InputNumberProps } from 'antd';

/** 1250000.5 → "1,250,000.5" (InputNumber formatter). Харуулалт л. */
export function groupDigits(value: number | string | undefined | null): string {
  if (value === undefined || value === null || value === '') return '';
  const [int, dec] = String(value).split('.');
  const grouped = (int ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? `${grouped}.${dec}` : grouped;
}

/** ₮-ийн InputNumber-ийн нийтлэг props: таслалтай харагдац, дээд хязгаар нь гэрээний `money` (1e12). */
export const MONEY_INPUT_PROPS: InputNumberProps<number> = {
  min: 0,
  max: 1e12,
  controls: false,
  suffix: '₮',
  style: { width: '100%' },
  formatter: (value) => groupDigits(value),
  parser: (display) => (display ?? '').replace(/,/g, '') as unknown as number, // antd: parser нь тоон мөр буцааж болно
};
