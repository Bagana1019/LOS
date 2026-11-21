'use client';
import { useEffect, useRef } from 'react';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';

interface Props {
  error: unknown;
  testId: string;
}

/** Формын доор серверийн алдааг харуулна. Алдаа гарахад форм цонхны ирмэгт байсан ч харагдахаар гүйлгэнэ (F2-12). */
export function FormError({ error, testId }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  if (!error) return null;
  return <div ref={ref} data-testid={testId}><ApiErrorAlert error={error} /></div>;
}
