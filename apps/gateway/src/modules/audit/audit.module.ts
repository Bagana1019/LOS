import { Global, Module } from '@nestjs/common';
import { AUDIT_FALLBACK_QUEUE, createAuditFallbackQueue } from './audit-fallback-queue';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [{ provide: AUDIT_FALLBACK_QUEUE, useFactory: () => createAuditFallbackQueue(process.env) }, AuditService, AuditInterceptor],
  exports: [AuditService, AuditInterceptor, AUDIT_FALLBACK_QUEUE],
})
export class AuditModule {}
