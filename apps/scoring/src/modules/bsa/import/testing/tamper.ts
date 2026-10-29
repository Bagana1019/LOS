// ТЕСТИЙН туслах: SYNTHETIC хуулгын текстийг санаатайгаар эвдэх (BSA-FR-2.2: баталгаажуулалт барих ёстой).
import type { StatementText } from '../../parsers/statement.types';

const withLines = (text: StatementText, map: (cells: string[], isData: boolean, dataIndex: number) => string[]): StatementText => {
  let dataIndex = 0;
  return {
    ...text,
    pages: text.pages.map((p) => ({
      ...p,
      lines: p.lines.map((l) => {
        const isData = /^\s*\d{4}-\d{2}-\d{2}/.test(l.cells[0] ?? '');
        const cells = map(l.cells, isData, isData ? dataIndex : -1);
        if (isData) dataIndex += 1;
        return { ...l, cells, text: cells.join(' ') };
      }),
    })),
  };
};

/** `rowIndex` дэх (0-ээс) гүйлгээний мөрийн ҮЛДЭГДЭЛ нүдийн эхний цифрийг өөрчилнө (формат хадгалагдана) */
export const alterBalanceOfRow = (rowIndex: number) => (text: StatementText): StatementText =>
  withLines(text, (cells, isData, idx) => {
    if (!isData || idx !== rowIndex) return cells;
    const out = [...cells];
    const last = out.length - 1;
    out[last] = out[last].replace(/\d/, (d) => String((Number(d) + 4) % 10));
    return out;
  });

/** Хуулгын толгой дахь «Нийт гүйлгээний тоо» нүдийн утгыг солино (inline placement) */
export const setDeclaredCount = (declared: number) => (text: StatementText): StatementText => ({
  ...text,
  pages: text.pages.map((p) => ({
    ...p,
    lines: p.lines.map((l) => {
      const cells = l.cells.map((c) => (c.includes('Нийт гүйлгээний тоо') ? c.replace(/\d+\s*$/, String(declared)) : c));
      return { ...l, cells, text: cells.join(' ') };
    }),
  })),
});
