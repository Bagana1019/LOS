import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { resolveDwhUrl } from './dwh-config';
import { createDwhDatabase, DWH_DATABASE, type DwhDatabase } from './dwh-database';
import { DwhSchemaService } from './dwh-schema';

/** DWH Postgres connection (DWH_DATABASE_URL; refuses the operational DB) + startup schema migration (dwh-schema.ts). */
@Global()
@Module({
  providers: [{ provide: DWH_DATABASE, useFactory: (): DwhDatabase => createDwhDatabase(resolveDwhUrl(process.env)) }, DwhSchemaService],
  exports: [DWH_DATABASE, DwhSchemaService],
})
export class EtlModule implements OnApplicationShutdown {
  constructor(@Inject(DWH_DATABASE) private readonly db: DwhDatabase) {}
  async onApplicationShutdown(): Promise<void> { await this.db.close(); }
}
