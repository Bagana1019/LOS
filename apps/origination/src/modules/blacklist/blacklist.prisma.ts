import type { Provider } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

export const BLACKLIST_PRISMA = Symbol('BLACKLIST_PRISMA');

/** origination-ийн цорын ганц PrismaClient (`PrismaModule`, глобал) — холболтыг тэнд удирдана. Repository зөвхөн `BlacklistPrismaClient` хэсгийг хэрэглэнэ. */
export const blacklistPrismaProvider: Provider = { provide: BLACKLIST_PRISMA, useExisting: PrismaService };
