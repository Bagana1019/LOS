import { describe, expect, it } from 'vitest';
import { FATF_FIXTURE } from './fatf.fixture';
import { MockFatfClient } from './mock-fatf.client';

describe('MockFatfClient', () => {
  it('returns the fixture deterministically', async () => {
    const client = new MockFatfClient();
    expect(await client.fetchSnapshot()).toEqual(FATF_FIXTURE);
    expect(await client.fetchSnapshot()).toEqual(await client.fetchSnapshot());
  });

  it('returns a fresh copy so callers cannot corrupt the fixture', async () => {
    const client = new MockFatfClient();
    const first = await client.fetchSnapshot();
    expect(first).not.toBe(FATF_FIXTURE);
    first.entries.length = 0;
    first.version = 'tampered';
    expect(await client.fetchSnapshot()).toEqual(FATF_FIXTURE);
  });
});
