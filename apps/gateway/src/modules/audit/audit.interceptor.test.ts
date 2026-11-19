import { EventEmitter } from 'node:events';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuditInterceptor } from './audit.interceptor';
import type { AuditRecord, AuditService } from './audit.service';

// M10: HTTP аудитын мөрийн чөлөөт талбар (зам → entityId) хязгаартай — энгийн хүсэлт poison мөр үүсгэхгүй.
function run(originalUrl: string, method = 'POST') {
  const recorded: AuditRecord[] = [];
  const audit = { recordSafe: vi.fn((r: AuditRecord) => { recorded.push(r); }) } as unknown as AuditService;
  const res = Object.assign(new EventEmitter(), { statusCode: 201 });
  const req = { method, originalUrl, ip: '10.0.0.1', headers: { 'user-agent': 'ua', 'x-correlation-id': 'c-1' } };
  const ctx = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
  new AuditInterceptor(audit).intercept(ctx as never, { handle: () => of(null) }).subscribe();
  res.emit('finish');
  return recorded;
}

describe('AuditInterceptor field bounds (M10)', () => {
  it('records method + id-normalised path without the query', () => {
    const [r] = run('/api/origination/applications/0b6f3c1e-9f3a-4d0e-9a2c-1b2c3d4e5f60/submit?token=secret');
    expect(r).toMatchObject({ entity: 'HTTP', entityId: 'POST /api/origination/applications/:id/submit', action: 'HTTP_POST' });
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('bounds an over-long path so the row stays insertable', () => {
    const [r] = run(`/api/${'a'.repeat(20_000)}`);
    expect(r!.entityId.length).toBeLessThanOrEqual(512);
    expect(r!.entityId.startsWith('POST /api/aaa')).toBe(true);
  });

  it('sanitizes a lone surrogate and NUL in the path (client-controlled) before it reaches the audit row', () => {
    const [r] = run('/api/x\uD800y\u0000z');
    expect(r!.entityId).toBe('POST /api/x�yz');
  });

  it('does not audit reads', () => { expect(run('/api/x', 'GET')).toHaveLength(0); });
});
