'use client';
import type { ReactNode } from 'react';
import { ApplicationWizard } from '../../../../features/applications';

// docs/01 §2.2: `/los/loan-application/:id/<step>` бүгдэд нэг wizard (зүүн самбар: алхмын төлөв, тоолуур, цоож).
export default function Layout({ children }: { children: ReactNode }) {
  return <ApplicationWizard>{children}</ApplicationWizard>;
}
