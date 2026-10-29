import { describe, it, expect } from 'vitest';
import { resolveIntegrationMode } from './integration-mode';

describe('resolveIntegrationMode', () => {
  it.each([
    ['mock', 'mock'],
    ['real', 'real'],
    ['  MOCK ', 'mock'],
    ['Real', 'real'],
  ])('accepts INTEGRATION_MODE=%j as %s', (raw, expected) => {
    expect(resolveIntegrationMode({ INTEGRATION_MODE: raw })).toBe(expected);
  });

  it('lets an explicit mode win over NODE_ENV', () => {
    expect(resolveIntegrationMode({ INTEGRATION_MODE: 'mock', NODE_ENV: 'production' })).toBe('mock');
    expect(resolveIntegrationMode({ INTEGRATION_MODE: 'real', NODE_ENV: 'development' })).toBe('real');
  });

  it.each(['sandbox', 'mocks', '1', 'true'])('rejects the unknown value %j', (raw) => {
    expect(() => resolveIntegrationMode({ INTEGRATION_MODE: raw })).toThrow(/INTEGRATION_MODE must be 'mock' or 'real'/);
  });

  it('rejects an unknown value even in development', () => {
    expect(() => resolveIntegrationMode({ INTEGRATION_MODE: 'sandbox', NODE_ENV: 'development' })).toThrow(/sandbox/);
  });

  it.each([undefined, 'development', 'test', ''])('defaults to mock when unset and NODE_ENV is %j', (nodeEnv) => {
    expect(resolveIntegrationMode({ NODE_ENV: nodeEnv })).toBe('mock');
  });

  it('defaults to mock when nothing is configured at all', () => {
    expect(resolveIntegrationMode({})).toBe('mock');
  });

  it.each([undefined, '', '   '])('refuses to default in production when INTEGRATION_MODE is %j', (raw) => {
    expect(() => resolveIntegrationMode({ INTEGRATION_MODE: raw, NODE_ENV: 'production' })).toThrow(/production/);
  });
});
