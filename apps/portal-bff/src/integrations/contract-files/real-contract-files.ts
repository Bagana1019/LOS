import { PortalContractInfo } from '@los/contracts';
import type { CallContext } from '../../common/request-context';
import { PortalError } from '../../common/portal-error';
import { InternalHttpClient, seg } from '../internal-http.client';
import type { ContractDownload, ContractFilesPort } from './contract-files.port';

const base = (loanId: string) => `/api/internal/portal/loans/${seg(loanId)}/contract`;

/** origination `/contract` (meta) ба `/contract/content` (PDF; origination өөрөө dms-ээс авч дамжуулна). */
export class RealContractFiles implements ContractFilesPort {
  constructor(private readonly http: InternalHttpClient) {}

  getInfo(ctx: CallContext, loanId: string) {
    return this.http.json({ method: 'GET', path: base(loanId), ctx, schema: PortalContractInfo, notFound: 'CONTRACT_NOT_AVAILABLE' });
  }

  async open(ctx: CallContext, loanId: string): Promise<ContractDownload> {
    const info = await this.getInfo(ctx, loanId);
    const { headers, stream } = await this.http.stream({ path: `${base(loanId)}/content`, ctx, notFound: 'CONTRACT_NOT_AVAILABLE' });
    const type = headers.get('content-type')?.split(';')[0].trim();
    if (type !== 'application/pdf') {
      stream.destroy();
      throw new PortalError('DOWNSTREAM_INVALID_RESPONSE');
    }
    // Content-Length нь эх урсгалын (шахсан/ задлагдаагүй) хэмжээ: fetch задалсан бол хэмжээ таарахгүй тул дамжуулахгүй
    const declared = Number(headers.get('content-length'));
    const encoded = (headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity';
    return { info, stream, ...(!encoded && Number.isInteger(declared) && declared > 0 ? { contentLength: declared } : {}) };
  }
}
