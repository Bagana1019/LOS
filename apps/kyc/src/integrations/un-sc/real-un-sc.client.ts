import { IntegrationNotImplementedError } from '../errors';
import type { UnScClient, UnSanctionsSnapshot } from './un-sc.client';

export const UN_SC_DEFAULT_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';

export interface RealUnScConfig { url?: string }

/**
 * TODO(human): НҮБ-ын нэгдсэн жагсаалтыг бодитоор татах.
 *  1. GET https://scsanctions.un.org/resources/xml/en/consolidated.xml (timeout 15с, CLAUDE.md §3.1).
 *  2. INDIVIDUAL / ENTITY зангилаа бүрийг UnSanctionedParty болгож parse хийнэ: нэр + alias (quality: PRIMARY / GOOD_ALIAS / LOW_ALIAS),
 *     төрсөн огноо ('YYYY' | 'YYYY-MM-DD'), иргэншил (улсын нэрийг ISO alpha-2 болгоно), бичиг баримт (type/value/country).
 *  3. version = XML-ийн dateGenerated attribute; хоосон / parse алдаатай хариуг шидэх (WatchlistService хоосон snapshot-ыг татгалзана).
 *  Урьдчилсан нөхцөл: сүлжээний allow-list (scsanctions.un.org) болон хууль зүйн хяналт.
 */
export class RealUnScClient implements UnScClient {
  readonly url: string;

  constructor(config: RealUnScConfig = {}) {
    this.url = config.url ?? UN_SC_DEFAULT_URL;
  }

  async fetchSnapshot(): Promise<UnSanctionsSnapshot> {
    throw new IntegrationNotImplementedError('un-sc');
  }
}
