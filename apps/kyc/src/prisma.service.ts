import { Global, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { connectPrismaWithRetry } from '@los/database';
import { PrismaClient, type Prisma } from '.prisma/client-kyc';

/** kyc сервисийн цорын ганц PrismaClient (schema: kyc). */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  // M8: DB түр унасан бол backoff-оор дахин холбогдоно (DB_CONNECT_MAX_WAIT_MS, анхдагч 60с); төсөв дуусвал bootstrap exit(1).
  async onModuleInit() { await connectPrismaWithRetry(this, new Logger('Prisma')); }
  async onModuleDestroy() { await this.$disconnect(); }
}
export type Tx = Prisma.TransactionClient;

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
