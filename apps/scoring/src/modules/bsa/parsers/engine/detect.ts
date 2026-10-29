// Банк таних оноо (0..1): банкны нэрийн түлхүүр үг (ЗӨВХӨН толгой хэсэгт, бүтэн үгээр) + бүтцийн тэмдэг. BSA-FR-2.1.
// Гүйлгээний утга дахь 'Khan', 'TDB' зэрэг үг оноонд нөлөөлөхгүй: толгой хэсэг = хүснэгтийн толгой/эхний гүйлгээний мөрөөс өмнөх мөрүүд.
import { toMatchKey } from '@los/ocr';
import type { StatementText } from '../statement.types';
import type { BankProfile } from './bank-profile';
import { compileProfile } from './compiled-profile';
import type { EngineOptions } from './defaults';
import type { ZoneLine } from './header-block';
import { parseRowLine, type RowContext } from './row-parser';
import { clip, rowCells } from './text-utils';
import { WarningCollector } from './warnings';

const KEY_MAX_CHARS = 300;

export function scoreTableStatement(text: StatementText, profile: BankProfile, options: EngineOptions = {}): number {
  const c = compileProfile(profile, options);
  const { cfg } = c;
  const w = cfg.detect;
  const page = text.pages[0];
  if (!page) return 0;
  const ctx: RowContext = {
    cfg,
    order: profile.dateOrder,
    header: null,
    debitDir: 'EXPENSE',
    creditDir: 'INCOME',
    spaceThousands: profile.spaceThousands === true,
    markerKeys: c.markerKeys,
  };

  const zone: ZoneLine[] = [];
  let headerFound = false;
  for (let i = 0; i < page.lines.length && i < cfg.headerZoneMaxLines; i++) {
    const line = page.lines[i];
    if (line.text.trim() === '') continue;
    const cells = rowCells(line, cfg);
    const res = parseRowLine(cells, page.pageNo, i + 1, ctx);
    if (res.kind === 'row' || res.kind === 'marker') break; // хүснэгтийн бие эхэллээ
    if (res.kind === 'none' && c.matcher.detectHeader(line)) {
      headerFound = true;
      break;
    }
    zone.push({ cells, page: page.pageNo, line: i + 1 });
  }
  if (zone.length === 0 && !headerFound) return 0;

  // Бүтэн үгээр тулгана: түлхүүрүүдийг зайгаар хүрээлж `includes`
  const keys = zone.map((z) => ` ${toMatchKey(clip(z.cells.join(' '), KEY_MAX_CHARS))} `);
  const hasAny = (list: string[], line: string): boolean => list.some((k) => line.includes(` ${k} `));
  if (keys.some((line) => hasAny(c.rejectKeys, line))) return 0;
  const titleHit = keys.slice(0, cfg.titleZoneLines).some((line) => hasAny(c.nameKeys, line));
  const headerHit = titleHit || keys.some((line) => hasAny(c.nameKeys, line));

  let score = titleHit ? w.titleKeyword : headerHit ? w.headerKeyword : 0;
  if (headerFound) score += w.tableHeader;
  const labels = c.extractor.extractZone(zone, new WarningCollector(1));
  const labelCount = [labels.accountNo, labels.iban, labels.holderName, labels.periodFrom, labels.openingBalance, labels.closingBalance].filter(
    (v) => v !== null,
  ).length;
  score += Math.min(labelCount, w.headerLabelMax) * w.headerLabel;
  const zoneText = zone.map((z) => clip(z.cells.join(' '), KEY_MAX_CHARS)).join('\n');
  const cueCount = (profile.structuralCues ?? []).filter((re) => re.test(zoneText)).length;
  score += Math.min(cueCount, w.cueMax) * w.cue;
  if (!headerHit) score = Math.min(score, w.noKeywordMax);
  return Math.round(Math.min(1, score) * 100) / 100;
}
