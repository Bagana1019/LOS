import type { AmlSubject } from '@los/contracts';
import { normalizeName } from '../matching';

/** Тулгах нэрийн хувилбарууд: овог+нэр (дараалал хамаарахгүй — matching тал нь token-оор), бусад нэр. ААН-д зөвхөн нэр. */
export function subjectNames(subject: Pick<AmlSubject, 'lastName' | 'firstName' | 'aliases'>): string[] {
  const full = [subject.lastName, subject.firstName].filter(Boolean).join(' ').trim();
  const seen = new Set<string>();
  return [full, ...subject.aliases].map((n) => n.trim()).filter((n) => n && !seen.has(n) && seen.add(n));
}

/**
 * Нэрээр шалгах боломжтой эсэх: нэрийн ядаж нэг хувилбар нормчилсны дараа хоосон биш. '---', '()', үл үзэгдэх тэмдэгт, emoji зэрэг
 * нь нормчлогдоод хоосон болдог; тэгвэл нэрийн тулгалт огт ажиллаагүй мөртөө screening "CLEAR" болж харагддаг (FR-3.4).
 */
export function hasScreenableName(subject: Pick<AmlSubject, 'lastName' | 'firstName' | 'aliases'>): boolean {
  return subjectNames(subject).some((name) => normalizeName(name) !== '');
}

/** 'YYYY' эсвэл 'YYYY-MM-DD' → он. */
export function yearOf(date: string): number | null {
  const m = /^(\d{4})(?:-\d{2}-\d{2})?$/.exec(date.trim());
  return m ? Number(m[1]) : null;
}
