import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from './errors';

describe('IntegrationNotConfiguredError', () => {
  it('names the missing variables but carries no values', () => {
    const err = new IntegrationNotConfiguredError('sainscore', ['SAINSCORE_BASE_URL', 'SAINSCORE_USERNAME']);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('IntegrationNotConfiguredError');
    expect(err.integration).toBe('sainscore');
    expect(err.missing).toEqual(['SAINSCORE_BASE_URL', 'SAINSCORE_USERNAME']);
    expect(err.message).toContain('SAINSCORE_BASE_URL, SAINSCORE_USERNAME');
  });
});

describe('IntegrationNotImplementedError', () => {
  it('is an Error carrying the integration name', () => {
    const err = new IntegrationNotImplementedError('un-sc');
    expect(err).toBeInstanceOf(Error);
    expect(err.integration).toBe('un-sc');
    expect(err.name).toBe('IntegrationNotImplementedError');
    expect(err.message).toContain('un-sc');
  });
});
