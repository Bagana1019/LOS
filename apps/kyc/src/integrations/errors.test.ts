import { describe, expect, it } from 'vitest';
import { IntegrationNotImplementedError } from './errors';

describe('IntegrationNotImplementedError', () => {
  it('is an Error carrying the integration name', () => {
    const err = new IntegrationNotImplementedError('un-sc');
    expect(err).toBeInstanceOf(Error);
    expect(err.integration).toBe('un-sc');
    expect(err.name).toBe('IntegrationNotImplementedError');
    expect(err.message).toContain('un-sc');
  });
});
