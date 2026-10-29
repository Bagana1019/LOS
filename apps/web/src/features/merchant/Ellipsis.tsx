import type { ReactNode } from 'react';

/** Хүснэгтийн нүдэнд нэг мөрөнд багтаж, урт бол "…"-ээр тасарна; бүтэн текст нь tooltip (`title`) болон DOM-д үлдэнэ (screen reader бүтнийг уншина). */
export function Ellipsis({ text, className, children }: { text: string; className?: string; children?: ReactNode }) {
  return <span className={`mp-ellipsis${className ? ` ${className}` : ''}`} title={text}>{children ?? text}</span>;
}
