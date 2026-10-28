import { createRequire } from 'node:module';
import type * as Generated from '.prisma/client-origination';

/**
 * origination сервисийн Prisma клиент (schema `origination`, apps/origination/prisma/schema.prisma).
 * Generated клиент `node_modules/.prisma/client-origination` дотор тул bare specifier-ийг Node-ын `require`-ээр уншина
 * (Vite/Vitest нь `.`-ээр эхэлсэн bare specifier-ийг resolve хийж чадахгүй). Төрлүүд нь `import type`-аар хэвээр.
 */
const nodeRequire = createRequire(__filename);
export const prismaRuntime = nodeRequire('.prisma/client-origination') as typeof Generated;

export const MAKER_CHECKER_PRISMA = Symbol('MAKER_CHECKER_PRISMA');
export const makerCheckerPrismaFactory = { provide: MAKER_CHECKER_PRISMA, useFactory: () => new prismaRuntime.PrismaClient() };
