// Бодит хуулгын жишээ (samples/) олох туслах. samples/ одоогоор ХООСОН — энэ нь файл ирмэгц parser-ийг баталгаажуулах "hook".
// Файл бүрт зэрэгцээ `.txt` dump (хуудсыг \f, мөрийг \n, нүдийг TAB) байвал StatementTextService-гүйгээр parse хийнэ.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { BankCode } from '@los/contracts';

/** samples/<хавтас> → банк. samples/README.md-тэй нийцнэ */
export const SAMPLE_DIRS: Record<string, BankCode> = {
  khan: 'KHAN',
  golomt: 'GOLOMT',
  tdb: 'TDB',
  xac: 'XAC',
  capitron: 'CAPITRON',
  state: 'STATE',
  'm-bank': 'MBANK',
};

export interface SampleCase {
  bank: BankCode;
  /** Жишээ файлын нэр (хавтсанд харьцангуй) — хувийн мэдээлэл агуулахгүй гэж үзнэ, гэхдээ тестийн нэрэнд л ашиглана */
  name: string;
  mimeType: string;
  /** Зэрэгцээ .txt dump олдсон бол түүний агуулга, үгүй бол null (TODO: dump үүсгэх) */
  dump: string | null;
}

const IGNORED = new Set(['readme.md', '.gitkeep', '.gitignore', '.ds_store']);
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
};

/** Жишээ файлуудын жагсаалт. Хавтас байхгүй/хоосон бол []. `.txt` нь dump тул өөрөө тусдаа жишээ биш (original-тай нь хамт). */
export function discoverSamples(root: string): SampleCase[] {
  const out: SampleCase[] = [];
  for (const [dir, bank] of Object.entries(SAMPLE_DIRS)) {
    const folder = path.join(root, dir);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) continue;
    const entries = readdirSync(folder).filter((f) => !IGNORED.has(f.toLowerCase()) && statSync(path.join(folder, f)).isFile());
    const dumps = new Set(entries.filter((f) => f.toLowerCase().endsWith('.txt')));
    const claimed = new Set<string>();
    for (const file of entries.filter((f) => !dumps.has(f)).sort()) {
      const stem = file.slice(0, file.length - path.extname(file).length);
      const sibling = [`${stem}.txt`, `${file}.txt`].find((d) => dumps.has(d));
      if (sibling) claimed.add(sibling);
      out.push({
        bank,
        name: `${dir}/${file}`,
        mimeType: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        dump: sibling ? readFileSync(path.join(folder, sibling), 'utf8') : null,
      });
    }
    // Зөвхөн dump байгаа (original байхгүй) бол dump өөрийг нь жишээ болгоно
    for (const d of [...dumps].filter((x) => !claimed.has(x)).sort()) {
      out.push({ bank, name: `${dir}/${d}`, mimeType: 'text/plain', dump: readFileSync(path.join(folder, d), 'utf8') });
    }
  }
  return out;
}
