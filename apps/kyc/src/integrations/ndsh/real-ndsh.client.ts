import type { NdshSalaryRow } from '@los/contracts';
import { IntegrationNotImplementedError } from '../errors';
import type { NdshClient } from './ndsh.client';

/** Бодит НДШ холболт хараахан хийгдээгүй — fail closed. */
export class RealNdshClient implements NdshClient {
  async getSalaries(_registerNo: string): Promise<NdshSalaryRow[]> {
    throw new IntegrationNotImplementedError('ndsh');
  }
}
