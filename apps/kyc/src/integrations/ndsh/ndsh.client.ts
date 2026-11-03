// НДШ (Нийгмийн даатгалын ерөнхий газар) — цалин, шимтгэл (FR-4.1). Interface + Mock + Real (CLAUDE.md §3.2.7).
import type { NdshSalaryRow } from '@los/contracts';

export interface NdshClient {
  /** @param registerNo нормчилсон регистр. Сүүлийн 24 сарын мөр (олон ажил олгогч нэг сард олон мөр). Түр унавал `NdshUnavailableError`. */
  getSalaries(registerNo: string): Promise<NdshSalaryRow[]>;
}
export const NDSH_CLIENT = Symbol('NDSH_CLIENT');

export class NdshUnavailableError extends Error {
  constructor(message = 'НДШ-ийн сервис түр ажиллахгүй байна') {
    super(message);
    this.name = 'NdshUnavailableError';
  }
}
