import type { Provider } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

export const AML_PRISMA = Symbol('AML_PRISMA');

/** kyc-ийн цорын ганц PrismaClient (`PrismaModule`, глобал) — холболтыг тэнд удирдана. */
export const amlPrismaProvider: Provider = { provide: AML_PRISMA, useExisting: PrismaService };
