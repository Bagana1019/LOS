// BSA persistence-ийн Nest модуль: PrismaService + BSA_REPOSITORY (PrismaBsaRepository).
// PII_CIPHER-ийг (infra.ports.ts) өөр модуль (common) гаргаж өгнө — түүнийг `register({ imports: [CommonModule] })`-ээр эсвэл @Global() модулиар
// харагдуулна. Тест/DB-гүй орчинд `useExisting`/override-аар InMemoryBsaRepository-г BSA_REPOSITORY-д холбоно.
import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { BSA_REPOSITORY } from './bsa.repository';
import { PrismaBsaRepository } from './prisma-bsa.repository';
import { BSA_REPOSITORY_OPTIONS, type PrismaBsaRepositoryOptions } from './prisma-support';
import { PrismaService } from './prisma.service';

@Module({})
export class BsaPersistenceModule {
  /** `imports`: PII_CIPHER-ийг экспортолдог модуль(ууд); `options`: транзакцийн timeout, chunk хэмжээ (prisma-support.ts) */
  static register(opts: { imports?: ModuleMetadata['imports']; options?: PrismaBsaRepositoryOptions } = {}): DynamicModule {
    return {
      module: BsaPersistenceModule,
      imports: opts.imports ?? [],
      providers: [
        PrismaService,
        PrismaBsaRepository,
        { provide: BSA_REPOSITORY, useExisting: PrismaBsaRepository },
        { provide: BSA_REPOSITORY_OPTIONS, useValue: opts.options },
      ],
      exports: [BSA_REPOSITORY, PrismaService],
    };
  }
}
