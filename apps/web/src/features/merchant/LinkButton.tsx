'use client';
import { Button, type ButtonProps } from 'antd';
import { useRouter } from 'next/navigation';
import type { MouseEvent } from 'react';

/** Жинхэнэ `<a href>` (ctrl+click, hover-д URL) боловч энгийн дарахад Next client navigation. */
export function LinkButton({ href, onClick, children, ...rest }: Omit<ButtonProps, 'href' | 'htmlType'> & { href: string }) {
  const router = useRouter();
  const handle = (e: MouseEvent<HTMLElement>) => {
    onClick?.(e as MouseEvent<HTMLButtonElement>);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.push(href);
  };
  return <Button {...rest} href={href} onClick={handle}>{children}</Button>;
}
