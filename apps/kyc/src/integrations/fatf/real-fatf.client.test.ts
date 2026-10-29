import { describe, expect, it } from 'vitest';
import { IntegrationNotImplementedError } from '../errors';
import { RealFatfClient } from './real-fatf.client';

describe('RealFatfClient', () => {
  it('does not pretend to work: fetchSnapshot rejects with IntegrationNotImplementedError', async () => {
    const err = await new RealFatfClient().fetchSnapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationNotImplementedError);
    expect((err as IntegrationNotImplementedError).integration).toBe('fatf');
  });

  it('accepts an optional url', () => {
    expect(new RealFatfClient().url).toBeUndefined();
    expect(new RealFatfClient({ url: 'https://example.test/fatf.json' }).url).toBe('https://example.test/fatf.json');
  });
});
