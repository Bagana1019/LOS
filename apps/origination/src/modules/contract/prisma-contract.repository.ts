import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { SigningFailureReason, SigningStatus } from '@los/contracts';
import { recordAudit } from '@los/database';
import { getRequestContext } from '@los/nest-common';
import type { Contract, Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { SignChannel, type ContractRecord, type ContractRepository, type SigningGuard, type SigningPatch } from './contract.repository';

const Channel = z.enum(SignChannel);
const Status = z.enum(SigningStatus).nullable();
const Reason = z.enum(SigningFailureReason).nullable();

function toRecord(row: Contract): ContractRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    applicationId: row.applicationId,
    contractNo: row.contractNo,
    templateVersion: row.templateVersion,
    generatedFileId: row.generatedFileId,
    signedFileId: row.signedFileId,
    signedAt: row.signedAt,
    // DB-ийн CHECK constraint-ууд эдгээрийг баталгаажуулдаг; parse нь төрлийг явуулахад л үйлчилнэ
    signChannel: Channel.parse(row.signChannel),
    signingRequestId: row.signingRequestId,
    signingStatus: Status.parse(row.signingStatus),
    signingFailureReason: Reason.parse(row.signingFailureReason),
    signingSentAt: row.signingSentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class PrismaContractRepository implements ContractRepository {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async getByApplicationId(applicationId: string): Promise<ContractRecord | null> {
    const row = await this.db.contract.findUnique({ where: { applicationId } });
    return row ? toRecord(row) : null;
  }

  async updateSigning(applicationId: string, patch: SigningPatch, guard?: SigningGuard): Promise<boolean> {
    // Нэг UPDATE ... WHERE — уншаад-бичих race-гүй. `signing_status <> 'SIGNED'` NULL-д үнэн болохгүй тул OR IS NULL заавал.
    const where: Prisma.ContractWhereInput = {
      applicationId,
      OR: [{ signingStatus: null }, { signingStatus: { not: 'SIGNED' } }],
      ...(guard?.expectedRequestId === undefined ? {} : { signingRequestId: guard.expectedRequestId }),
    };
    // NFR-4: өөрчлөлт бүр аудитад (хэн/хэзээ/юу) — бизнес бичлэгтэй нэг транзакцид. Хэрэглэгч байхгүй (consumer) бол систем.
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.contract.updateMany({ where, data: patch });
      if (count !== 1) return false;
      const row = await tx.contract.findUniqueOrThrow({ where: { applicationId }, select: { id: true, orgId: true } });
      const ctx = getRequestContext();
      await recordAudit(tx, {
        orgId: row.orgId, entity: 'CONTRACT', entityId: row.id, action: 'CONTRACT_SIGNING_UPDATED', actorId: ctx?.userId ?? null,
        afterJson: patch, applicationId, correlationId: ctx?.correlationId ?? null,
      });
      return true;
    });
  }
}
