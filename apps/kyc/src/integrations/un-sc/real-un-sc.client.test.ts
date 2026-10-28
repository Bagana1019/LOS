import { describe, expect, it } from 'vitest';
import { IntegrationNotImplementedError } from '../errors';
import { RealUnScClient, UN_SC_DEFAULT_URL } from './real-un-sc.client';

describe('RealUnScClient', () => {
  it('does not pretend to work: fetchSnapshot rejects with IntegrationNotImplementedError', async () => {
    const err = await new RealUnScClient().fetchSnapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationNotImplementedError);
    expect((err as IntegrationNotImplementedError).integration).toBe('un-sc');
  });

  it('defaults to the UN consolidated list URL and accepts an override', () => {
    expect(new RealUnScClient().url).toBe(UN_SC_DEFAULT_URL);
    expect(UN_SC_DEFAULT_URL).toBe('https://scsanctions.un.org/resources/xml/en/consolidated.xml');
    expect(new RealUnScClient({ url: 'https://example.test/un.xml' }).url).toBe('https://example.test/un.xml');
  });
});
