// Input validation shared by the reject/approve modals and the policy form. Limits mirror @los/contracts.
import { mn } from '@los/ui';
import { fmt } from './labels';

/** RejectChangeRequest.comment: min 3 (trimmed). Also the minimum for a policy change reason. */
export const COMMENT_MIN = 3;
export const COMMENT_MAX = 2000;
/** MakerCheckerPolicy.expiresInHours */
export const EXPIRES_MIN = 1;
export const EXPIRES_MAX = 24 * 30;

export type TextError = 'required' | 'too_short' | 'too_long';

export interface TextRules {
  required: boolean;
  min?: number;
  max?: number;
}

/**
 * Validates the trimmed text (the server trims too). null means valid.
 * Mirrors the server: the minimum counts code points (PostgreSQL char_length), the maximum counts UTF-16 units (zod `.max`).
 */
export function validateText(value: string, { required, min = 0, max = COMMENT_MAX }: TextRules): TextError | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return required ? 'required' : null;
  if ([...trimmed].length < min) return 'too_short';
  if (trimmed.length > max) return 'too_long';
  return null;
}

export function textErrorMessage(error: TextError, rules: { min?: number; max?: number } = {}): string {
  if (error === 'required') return mn['maker_checker.comment.required'];
  if (error === 'too_short') return fmt(mn['maker_checker.comment.too_short'], { min: rules.min ?? COMMENT_MIN });
  return fmt(mn['maker_checker.comment.too_long'], { max: rules.max ?? COMMENT_MAX });
}

export const isValidExpiresInHours = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= EXPIRES_MIN && n <= EXPIRES_MAX;
