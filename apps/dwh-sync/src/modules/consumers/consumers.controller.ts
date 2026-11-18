// LOW (C3): operational information that must not flip readiness — schema version/reason and per-group dead-letter counts.
// No payloads, eventIds or PII. Internal network only (not routed by the gateway).
import { Controller, Get } from '@nestjs/common';
import { Public } from '@los/nest-common';
import { DwhSchemaService } from '../etl/dwh-schema';
import { ConsumerStatusRegistry } from './consumer-status';

@Controller('consumers')
export class ConsumersController {
  constructor(private readonly status: ConsumerStatusRegistry, private readonly schema: DwhSchemaService) {}

  @Public() @Get('status')
  get() { return { schema: this.schema.status(), ...this.status.snapshot() }; }
}
