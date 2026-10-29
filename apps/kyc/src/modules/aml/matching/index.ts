// Нэрийн fuzzy тулгалтын номын сан (цэвэр функц; I/O, Nest байхгүй). Screening engine зөвхөн эндээс импортлоно.
export { jaroWinkler } from './jaro-winkler';
export { normalizeName, normalizeNameForms, tokenize } from './normalize';
export { bestNameMatch, bestPreparedMatch, nameSimilarity, prepareName } from './name-similarity';
export type { NameMatch, NameOptions, PreparedName, ScoreOptions } from './name-similarity';
