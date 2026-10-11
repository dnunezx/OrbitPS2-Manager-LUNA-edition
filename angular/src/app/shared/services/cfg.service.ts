import { Injectable } from '@angular/core';
import { LibraryService } from './library.service';
import { LogsService } from './logs.service';

export type GameCfg = Record<string, string>;

/** OPL per-game config keys (the sigil is part of the key). */
export const CFG_KEY_NAME = '#Name';
export const CFG_KEY_GENRE = 'Genre';
export const CFG_METADATA_FIELDS = [
  { key: 'Release', label: 'Release date', placeholder: 'MM-DD-YYYY (or year)' },
  { key: 'Developer', label: 'Developer', placeholder: 'Developer' },
  { key: 'Genre', label: 'Genre', placeholder: 'Genre' },
  { key: 'PlayersText', label: 'Number of players', placeholder: '1, 2, or 1-4' },
  { key: 'Description', label: 'Description', placeholder: 'Game description' },
] as const;

/** Handle legacy # prefixed keys and OPL's players/<count> format. */
export function cfgMetadataValue(entries: GameCfg, field: string): string {
  let value = '';
  for (const [key, text] of Object.entries(entries)) {
    if (key.replace(/^#/, '').toLowerCase() === field.toLowerCase()) value = text;
  }
  if (field === 'PlayersText' && !value) return cfgMetadataValue(entries, 'Players').replace(/^players\//i, '');
  return value;
}
export const CFG_KEY_LONGNAME = '#LongName';
export const CFG_KEY_COMPAT = '$Compatibility';
export const CFG_KEY_VMC0 = '$VMC_0';
export const CFG_KEY_VMC1 = '$VMC_1';

/** Compatibility modes; bit N (value 1<<N) maps to OPL "Mode N+1". */
export const COMPAT_MODES: { bit: number; label: string; hint: string }[] = [
  { bit: 0, label: 'Accurate Reads', hint: 'Emulate CD/DVD drive read behaviour' },
  { bit: 1, label: 'Synchronous Mode', hint: 'Read data immediately rather than in background' },
  { bit: 2, label: 'Unhook Syscalls', hint: 'Do not stay resident after the game resets the IOP' },
  { bit: 3, label: '0 PSS mode', hint: 'Report PSS video sizes as zero so they are skipped' },
  { bit: 4, label: 'Emulate DVD-DL', hint: 'Handle flattened DVD9-to-DVD5 images' },
  { bit: 5, label: 'Disable IGR', hint: 'Turn off In-Game Reset' },
  { bit: 6, label: 'High module storage', hint: 'Shift module storage to avoid memory conflicts' },
  { bit: 7, label: 'Hide DEV9 module', hint: 'Prevent dev9 module visibility' },
];

@Injectable({
  providedIn: 'root',
})
export class CfgService {
  constructor(
    private readonly _library: LibraryService,
    private readonly _logger: LogsService
  ) { }

  async getGameCfg(gameId: string): Promise<GameCfg> {
    const root = this._library.currentDirectoryValue;
    if (!root) {
      this._logger.log('cfgService', `getGameCfg(${gameId}): no root directory`);
      return {};
    }
    const res = await window.libraryAPI.readGameCfg(root, gameId);
    if (!res.success) {
      this._logger.error('cfgService', `Failed to read CFG for ${gameId}: ${res.message}`);
      throw new Error(res.message || 'Unable to read game CFG');
    }
    const keys = Object.keys(res.entries);
    this._logger.log('cfgService', `CFG for ${gameId}: ${keys.length} key(s) [${keys.join(', ')}]`);
    return res.entries;
  }

  async saveGameCfg(gameId: string, entries: GameCfg, original?: GameCfg): Promise<boolean> {
    const root = this._library.currentDirectoryValue;
    if (!root) return false;
    const changes: Record<string, string | null> = {};
    if (original) {
      for (const key of new Set([...Object.keys(original), ...Object.keys(entries)])) {
        if (entries[key] !== original[key]) changes[key] = entries[key] ?? null;
      }
    }
    const res = original ? await window.libraryAPI.patchGameCfg(root, gameId, changes) :
      await window.libraryAPI.writeGameCfg(root, gameId, entries);
    if (!res.success) {
      this._logger.error('cfgService', `Failed to write CFG: ${res.message}`);
      return false;
    }
    this._logger.log('cfgService', `Saved CFG for ${gameId}`);
    return true;
  }

  async genreLabels(): Promise<string[]> { return window.libraryAPI.genreLabels(); }

  async lookupMetadata(gameId: string): Promise<GameCfg> {
    const res = await window.libraryAPI.lookupGameMetadata(gameId);
    if (!res.success) throw new Error(res.message || 'Unable to download metadata');
    return res.entries;
  }

  async readGenres(gameIds: string[]): Promise<LunaGenreResult[]> {
    const root = this._library.currentDirectoryValue;
    if (!root) return [];
    return window.libraryAPI.readGameGenres(root, gameIds);
  }

  async assignGenres(gameIds: string[], genre: string): Promise<LunaGenreResult[]> {
    const root = this._library.currentDirectoryValue;
    if (!root) return [];
    const results = await window.libraryAPI.assignGameGenres(root, gameIds, genre);
    this._library.applyGenres(results);
    return results;
  }

  async fillMissingGenres(gameIds: string[], system: 'PS1' | 'PS2' = 'PS2'): Promise<LunaGenreResult[]> {
    const root = this._library.currentDirectoryValue;
    if (!root) return [];
    const results = await window.libraryAPI.fillGameGenres(root, gameIds, system);
    this._library.applyGenres(results);
    return results;
  }
}
