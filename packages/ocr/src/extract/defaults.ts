// Задлалтын эвристикийн анхдагч утгууд — НЭГ газар. Бизнесийн босго БИШ (тэдгээр setting-ээс); энэ нь OCR-ийн итгэлийг
// нэгтгэх, шошго тааруулах техникийн параметр. ExtractOptions-оор дарж болно.
export const EXTRACT_DEFAULTS = {
  /** Итгэл энэ утгаас бага бол талбарт анхааруулга (note) нэмнэ */
  lowConfidenceThreshold: 0.6,
  /** Баталгаажсан (checksum/хуанли) талбарын итгэл 1 рүү энэ хувиар ойртоно */
  validationBoost: 0.5,
  /** Баталгаажуулалт бүтэлгүйтсэн үед итгэлийг үржүүлэх коэффициент */
  invalidPenalty: 0.3,
  /** Шошгоны засварын зай бүрийн торгууль */
  labelTypoPenalty: 0.05,
  /** Өөр талбараас тооцоолсон (унших биш) утгын коэффициент */
  derivedFactor: 0.9,
  /** Зөвхөн хэв маягаар (шошгогүй) олсон утгын коэффициент */
  heuristicFactor: 0.85,
  /** Баримтын төрөл таних доод оноо (0..1); үүнээс бага бол GENERIC */
  detectMinScore: 0.3,
  /** Цалингийн боломжит хязгаар (MNT) */
  minSalary: 50_000,
  maxSalary: 500_000_000,
  /** Цалин гэж үзэх нэр дэвшигчийн доод оноо (түлхүүр үг + мөнгөн тэмдэг) */
  salaryMinScore: 3,
  /** Шошго тааруулахад нэг удаад авах үгийн дээд тоо */
  maxLabelTokens: 4,
  /** Нэрийн дээд үгийн тоо */
  maxNameTokens: 3,
} as const;

export type ExtractSettings = {
  lowConfidenceThreshold: number;
  today: string | null;
  minSalary: number;
  maxSalary: number;
};
