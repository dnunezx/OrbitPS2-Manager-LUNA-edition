// Copyright (c) 2026 dnunezx — original LUNA Edition changes.
/** Friendly label for each known art-type suffix (`GAMEID_<code>.png`). */
export const ART_TYPE_LABELS: Record<string, string> = {
  COV: 'Cover',
  COV2: 'Cover (Alt 2)',
  COV3: 'Cover (Alt 3)',
  ICO: 'Icon',
  SCR: 'Screenshot',
  SCR2: 'Screenshot 2',
  SCR3: 'Screenshot 3',
  BG: 'Background',
  LAB: 'Spine Label',
  LGO: 'Logo',
  PSBBN: 'PSBBN Jacket',
};

/** Returns a friendly label for a type code, falling back to the code itself. */
export function artTypeLabel(code: string): string {
  return ART_TYPE_LABELS[code] ?? code;
}

/**
 * Ordered superset of every art type this app knows about. Used by the bulk
 * dialog (which can't afford a per-game discovery call) and as a display
 * order for the single-game wizard's discovered types.
 */
export const KNOWN_ART_TYPES = [
  'COV',
  'COV2',
  'COV3',
  'ICO',
  'SCR',
  'SCR2',
  'SCR3',
  'BG',
  'LAB',
  'LGO',
  'PSBBN',
];

export interface ArtworkPreset {
  id: string;
  label: string;
  /** null = "select everything available" rather than a fixed list. */
  types: string[] | null;
}

/**
 * Seed data, not an authoritative spec — hand-edit this list as the art
 * database grows or as loader-specific quirks are discovered.
 */
export const ARTWORK_PRESETS: ArtworkPreset[] = [
  { id: 'all', label: 'All Available', types: null },
  { id: 'opl', label: 'OpenPS2Loader', types: ['COV', 'ICO'] },
  { id: 'luna', label: 'LUNA PSBBN', types: ['COV', 'ICO', 'PSBBN'] },
  { id: 'riptopl', label: 'RiptOPL', types: ['COV', 'ICO', 'COV3'] },
  { id: 'minimal', label: 'Icon Only', types: ['ICO'] },
];
