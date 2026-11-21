'use client';
import { PercentInput, type NumberTextInputProps } from '../../components/form';

/**
 * Нэгжгүй тооны текст оролт (хугацаа/сар, оноо, ӨТЧХ коэффициент): хуваалцсан `PercentInput`-ийн текст→тоо задлагчийг ашиглаж, `%` дагаврыг авна.
 * antd InputNumber-ийн оронд — "5сая"→5, 700→600 зэрэг чимээгүй засвар байхгүй: ойлгогдохгүй бол NaN, дүрэм (`plainNumberRules`) мессеж үзүүлнэ.
 */
export function PlainNumberInput(props: NumberTextInputProps) {
  return <PercentInput {...props} suffix={props.suffix} />; // `suffix` өгөөгүй бол `%` дагавар гарахгүй; нэгж (км, м²) өгч болно
}
