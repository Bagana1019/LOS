import { Global, Module } from '@nestjs/common';
import { AUDIT_SINK, AuditService, LogAuditSink } from './audit.service';

@Global()
@Module({
  providers: [{ provide: AUDIT_SINK, useClass: LogAuditSink }, AuditService],
  exports: [AuditService, AUDIT_SINK],
})
export class AuditModule {}
