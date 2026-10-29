// Регистрийн дугаар талбар (ID карт, цалингийн тодорхойлолт хуваалцана): шошгын дараа → баримт даяар хайлт.
import type { ExtractSettings } from './defaults';
import type { OcrDoc } from './doc';
import { combineConfidence, emptyField, makeField } from './field';
import type { LabelHit } from './labels';
import { readLabelled } from './read';
import { findRegisterCandidates, type RegisterCandidate } from './scan';
import type { ExtractedField } from './types';

export interface RegisterResult {
  field: ExtractedField;
  /** Баталгаажсан (valid) бол регистрээс гарах төрсөн огноо/хүйс */
  info: { value: string; birthDate: string | null; gender: 'M' | 'F' | null } | null;
  warnings: string[];
}

export function resolveRegisterNo(doc: OcrDoc, hits: readonly LabelHit[], settings: ExtractSettings): RegisterResult {
  type Found = { cand: RegisterCandidate; start: number; labelDistance: number; heuristic: boolean };
  let found: Found | null = null;

  const labelled = readLabelled(doc, hits, 'registerNo', (seg) => {
    const cands = findRegisterCandidates(seg.text);
    const best = cands.find((c) => c.info.valid) ?? cands[0];
    return best ? { cand: best, offset: seg.start } : null;
  });
  if (labelled) found = { cand: labelled.value.cand, start: labelled.value.offset + labelled.value.cand.start, labelDistance: labelled.cand.hit.distance, heuristic: false };

  if (!found || !found.cand.info.valid) {
    // шошго олдоогүй/гэмтсэн үед баримт даяар хайна
    const scan = findRegisterCandidates(doc.text);
    const valid = scan.find((c) => c.info.valid);
    if (valid) found = { cand: valid, start: valid.start, labelDistance: 0, heuristic: true };
    else if (!found && scan[0]) found = { cand: scan[0], start: scan[0].start, labelDistance: 0, heuristic: true };
  }

  if (!found) return { field: emptyField('Олдсонгүй'), info: null, warnings: ['registerNo олдсонгүй'] };
  const span = doc.spanConf(found.start, found.start + found.cand.raw.length);
  if (!found.cand.info.valid) {
    const field = makeField(
      { value: null, raw: found.cand.raw, confidence: combineConfidence(span, { failed: true, heuristic: found.heuristic }), notes: ['Регистрийн дугаарын огноо/формат буруу - гараар шалгана уу'] },
      settings,
    );
    return { field, info: null, warnings: ['registerNo буруу: формат эсвэл төрсөн огноо хуанлийн хувьд зөрүүтэй'] };
  }
  const info = found.cand.info;
  let confidence = combineConfidence(span, { validated: true, labelDistance: found.labelDistance, heuristic: found.heuristic });
  if (found.cand.extraLetter) confidence = Math.round(confidence * 0.85 * 1000) / 1000;
  const field = makeField(
    {
      value: info.value,
      raw: found.cand.raw,
      confidence,
      notes: [
        found.cand.extraLetter ? 'Үсгийн хэсэгт илүү тэмдэгт байсан тул эхний 2 үсгийг авав' : undefined,
        found.cand.alternatives.length > 0 ? 'Латин B нь Б/В аль нь болох ойлгомжгүй' : undefined,
      ],
      alternatives: found.cand.alternatives,
    },
    settings,
  );
  return { field, info: { value: info.value as string, birthDate: info.birthDate, gender: info.gender }, warnings: [] };
}
