import { Global, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient, type Prisma } from '.prisma/client-gateway';

/** gateway-ийн цорын ганц PrismaClient (schema: iam). */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
export type Tx = Prisma.TransactionClient;

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
