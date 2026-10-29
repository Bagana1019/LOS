import { Global, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient, type Prisma } from '.prisma/client-origination';

/** origination сервисийн цорын ганц PrismaClient (schema: origination). */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
export type Tx = Prisma.TransactionClient;

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
