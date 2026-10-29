import type { Metadata } from 'next';
import { t } from '@los/ui';
import { LoginForm } from '../../components/auth/LoginForm';

export const metadata: Metadata = { title: t('auth.login.title') };

export default function LoginPage() {
  return <LoginForm />;
}
