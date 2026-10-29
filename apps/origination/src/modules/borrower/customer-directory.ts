import { Injectable } from '@nestjs/common';
import { blindIndex, decryptedField, maskRegisterNo } from '@los/database';
import type { Customer } from '.prisma/client-origination';
import type { Tx } from '../../prisma.service';

/** "Овог Нэр" (хуулийн этгээдэд зөвхөн нэр). */
export const customerDisplayName = (c: Pick<Customer, 'lastName' | 'firstName'>): string => [c.lastName, c.firstName].map((s) => s?.trim()).filter(Boolean).join(' ');

/** NFR-5: регистр DB-д шифрлэгдсэн. Задалсан утгыг зөвхөн тулгалтад (хар жагсаалт) ашиглаж, лог/API-д гаргахгүй. */
export const customerRegisterNo = (c: Pick<Customer, 'registerNoEncrypted'>): string => decryptedField(c.registerNoEncrypted);
export const customerRegisterNoMasked = (c: Pick<Customer, 'registerNoEncrypted'>): string => maskRegisterNo(customerRegisterNo(c));

/** Харилцагчийн лавлах (Модуль 1-ийн хүснэгтээс унших). Харилцагч бүртгэх/засах нь энд хамаарахгүй. */
@Injectable()
export class CustomerDirectory {
  findById(db: Tx, orgId: string, customerId: string): Promise<Customer | null> {
    return db.customer.findFirst({ where: { id: customerId, orgId } });
  }

  /** Регистрийг blind index-ээр хайна (том үсэг/хоосон зайг нормчилно). Олдохгүй бол null. */
  findByRegisterNo(db: Tx, orgId: string, registerNo: string): Promise<Customer | null> {
    return db.customer.findFirst({ where: { registerNoHash: blindIndex(registerNo), orgId } });
  }
}
