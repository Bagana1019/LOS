'use client';
import { Input, type InputProps, type InputRef } from 'antd';
import { useLayoutEffect, useRef, useState, type ChangeEvent, type FocusEvent } from 'react';
import { MONEY_CODEC, PERCENT_CODEC, caretAfter, formatNumberText, liveFormat, parseNumberText, significantBefore, toFieldValue, type NumberCodec } from './number-text';

export interface NumberTextInputProps extends Omit<InputProps, 'value' | 'defaultValue' | 'onChange' | 'type'> {
  value?: number | null;
  /** `undefined` = хоосон, `NaN` = тоо биш текст (Form дүрэм — `moneyRules`/`percentRules` — алдаа үзүүлнэ), бусад нь тоо. */
  onChange?: (value: number | undefined) => void;
}

/**
 * antd InputNumber-ийн оронд ТЕКСТ оролт: InputNumber нь үсэг/сөрөг тэмдгийг өөрөө хаяж, `min`-ээс бага утгыг clamp хийдэг тул "5сая" → 5, "-100" → 0 болж
 * чимээгүй хадгалагддаг байсан (F2-8). Энд хэрэглэгчийн бичсэн текст хэвээр үлдэж, утга нь ойлгогдвол тоо, үгүй бол NaN болно (дүрэм мессеж үзүүлнэ).
 * antd Form.Item-тэй `value`/`onChange`-ээр нийцнэ. Дүрэм: `number-rules.ts`.
 */
function NumberTextInput({ codec, value, onChange, onBlur, ...rest }: NumberTextInputProps & { codec: NumberCodec }) {
  const ref = useRef<InputRef>(null);
  const caret = useRef<number | null>(null);
  const [text, setText] = useState(() => formatNumberText(value, codec.grouping));

  // Утгыг гаднаас солиход (resetFields, initialValues, санал болгосон хүү) текстийг дагуулна; өөрийн бичсэн текстийн утгатай тэнцүү бол хөндөхгүй.
  const external = value ?? undefined;
  if (!Object.is(toFieldValue(parseNumberText(text, codec)), external)) {
    const synced = formatNumberText(external, codec.grouping);
    if (synced !== text) setText(synced);
  }

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const next = liveFormat(raw, codec.grouping, text); // text = өмнө нь харагдаж байсан утга
    caret.current = next !== raw && e.target.selectionStart !== null ? significantBefore(raw, e.target.selectionStart) : null;
    setText(next);
    onChange?.(toFieldValue(parseNumberText(next, codec)));
  };

  // Бүлэглэлтээр текст өөрчлөгдсөн бол курсорыг ижил цифрийн ард буцааж тавина (дунд нь засахад төгсгөл рүү үсрэхгүй).
  useLayoutEffect(() => {
    const el = ref.current?.input;
    if (caret.current !== null && el && document.activeElement === el) {
      const pos = caretAfter(el.value, caret.current);
      el.setSelectionRange(pos, pos);
    }
    caret.current = null;
  });

  // Анхаарал алдахад ойлгосон утгыг жигд харуулна ("5сая" → "5,000,000"); ойлгогдоогүй текстийг хэвээр үлдээж, алдаа харагдсаар байна.
  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    const parsed = parseNumberText(text, codec);
    if (parsed.kind === 'ok') setText(formatNumberText(parsed.value, codec.grouping));
    else if (parsed.kind === 'empty') setText('');
    onBlur?.(e);
  };

  return <Input inputMode="decimal" autoComplete="off" maxLength={32} {...rest} ref={ref} value={text} onChange={handleChange} onBlur={handleBlur} />;
}

/** ₮-ийн дүн: мянгатын таслал, "5сая"/"500мянга", буулгасан "5,000,000"/"5 000 000"; сөрөг/үсэг чимээгүй тасалдахгүй. Дүрэм: `moneyRules`. */
export function MoneyInput(props: NumberTextInputProps) {
  return <NumberTextInput suffix="₮" {...props} codec={MONEY_CODEC} />;
}

/** Хувь (1.5 = 1.5%): "1,5" ч болно. Форм дэх утга ХУВИАР; API-ийн бутархай руу `percentToRate`-аар хөрвүүлнэ. Дүрэм: `percentRules`. */
export function PercentInput(props: NumberTextInputProps) {
  return <NumberTextInput suffix="%" {...props} codec={PERCENT_CODEC} />;
}
