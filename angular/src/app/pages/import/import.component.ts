import { Component, OnInit } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { LibraryService } from '../../shared/services/library.service';
import { JobsService, ImportJobType } from '../../shared/services/jobs.service';
import { SettingsService } from '../../shared/services/settings.service';
import { AsyncPipe } from '@angular/common';

interface StagedFile {
  key: string;
  selected: boolean;
  archiveEntry?: string;
  path: string;
  fileName: string;
  gameId: string;
  gameName: string;
  detected: boolean;
  invalid: boolean;
  message?: string;
}

@Component({
  selector: 'app-import',
  imports: [LucideAngularModule, AsyncPipe],
  templateUrl: './import.component.html',
  styleUrl: './import.component.scss',
})
export class ImportComponent implements OnInit {
  constructor(
    public _libraryService: LibraryService,
    private _jobs: JobsService,
    private _settings: SettingsService
  ) {}

  importMode: ImportJobType = 'ps2-dvd';
  downloadArtwork = true;
  /** PS2 DVD only: keep the original filename (new OPL convention). */
  keepOriginalName = false;
  elfPrefix = 'XX.';
  /** PS1 preparation target, persisted independently of the disc-type choice. */
  launcherMode: 'popstarter' | 'popsloader' | 'psxcore' = 'popstarter';
  /** PS1 only: VCD art naming convention. */
  vcdArtNaming: 'gameId' | 'filename' = 'gameId';
  psxcoreStatus?: PsxcoreStatus;
  checkingPsxcore = false;

  async refreshPsxcoreStatus() {
    const root = this._libraryService.currentDirectoryValue;
    if (!root) return;
    this.checkingPsxcore = true;
    try { this.psxcoreStatus = await window.libraryAPI.getPsxcoreStatus(root); }
    catch (error: any) { this.psxcoreStatus = { success: false, message: error.message }; }
    finally { this.checkingPsxcore = false; }
  }

  async selectPsxcoreFile(kind: 'revisionFile' | 'bootstrap' | 'pops' | 'iop') {
    const result = await window.libraryAPI.selectPsxcoreFile(kind);
    if (!result.canceled) await this.refreshPsxcoreStatus();
  }

  async ngOnInit() {
    const settings = await this._settings.load();
    if (settings.ps1LauncherMode) {
      this.launcherMode = settings.ps1LauncherMode;
    }
    if (this.launcherMode === 'psxcore') await this.refreshPsxcoreStatus();
  }

  setLauncherMode(mode: 'popstarter' | 'popsloader' | 'psxcore') {
    this.launcherMode = mode;
    void this._settings.set('ps1LauncherMode', mode);
    if (mode === 'psxcore') void this.refreshPsxcoreStatus();
  }

  staged: StagedFile[] = [];
  scanning = false;

  get isGameCd(): boolean {
    return this.importMode === 'ps2-cd';
  }
  get isGameDvd(): boolean {
    return this.importMode === 'ps2-dvd';
  }
  get isGamePsx(): boolean {
    return this.importMode === 'ps1';
  }
  get isApp(): boolean {
    return this.importMode === 'apps';
  }

  /**
   * A staged entry is importable once it has a name; disc games additionally
   * need a game id (apps don't have one, and PS1 homebrew without a
   * registered id gets one auto-assigned at import time).
   */
  get readyCount(): number {
    return this.staged.filter(
      (f) => f.selected && (!this.isGamePsx || !f.invalid) && f.gameName && (this.isApp || this.isGamePsx || f.gameId)
    ).length;
  }

  setMode(mode: ImportJobType) {
    this.importMode = mode;
    this.staged = [];
  }

  async addFiles() {
    const result = this.isApp
      ? await window.libraryAPI.openAskElfFiles()
      : await window.libraryAPI.openAskGameFiles(
          this.isGameCd || this.isGamePsx,
          this.isGameDvd,
          this.isGamePsx
        );
    if (result?.canceled || !result?.filePaths?.length) {
      return;
    }

    this.scanning = true;
    try {
      for (const path of result.filePaths as string[]) {
        if (this.staged.some((f) => f.path === path)) {
          continue;
        }
        if (this.isGamePsx) {
          const info = await window.libraryAPI.inspectPs1Source(path);
          if (!info.success) {
            this.staged = [...this.staged, { ...this.stageApp(path), invalid: true, message: info.message }];
          } else if (info.discs?.length) {
            // Multi-disc archives are listed unselected for an explicit choice.
            this.staged = [...this.staged, ...info.discs.map(entry => ({
              key: path + '::' + entry, path, archiveEntry: entry, selected: info.discs!.length === 1,
              fileName: entry, gameName: entry.split(/[\\/]/).pop()!.replace(/\.(cue|vcd)$/i, ''),
              gameId: '', detected: false, invalid: false,
              message: info.discs!.length > 1 ? 'Select this disc to include it in the import queue.' : undefined,
            }))];
          } else {
            const staged = await this.detectFile(info.path!);
            if (!this.staged.some(f => f.path === staged.path)) this.staged = [...this.staged, staged];
          }
        } else this.staged = [...this.staged, this.isApp ? this.stageApp(path) : await this.detectFile(path)];
      }
    } finally {
      this.scanning = false;
    }
  }

  private stageApp(path: string): StagedFile {
    const fileName = path.split(/[\\/]/).pop() || path;
    const title = fileName.replace(/\.elf$/i, '');
    return { key: path, selected: true, path, fileName, gameId: '', gameName: title, detected: false, invalid: false };
  }

  private async detectFile(path: string): Promise<StagedFile> {
    const fileName = path.split(/[\\/]/).pop() || path;
    const detect = this.isGamePsx
      ? this._libraryService.tryDeterminePs1GameIdFromHex(path)
      : this._libraryService.tryDetermineGameIdFromHex(path);

    let message: string | undefined;
    try {
      const res: any = await detect;
      if (res?.success) {
        return {
          key: path, selected: true,
          path,
          fileName,
          gameId: res.gameId || '',
          gameName: res.gameName || fileName.replace(/\.(cue|vcd)$/i, '').replace(/^[A-Z]{4}_\d{3}\.\d{2}\./i, ''),
          detected: true,
          invalid: false,
        };
      }
      message = res?.message;
    } catch (err: any) {
      message = err?.message;
    }

    // PS1 discs with no registered game id (typically homebrew) can still be
    // converted to VCD — the backend auto-assigns a non-conflicting id, so
    // stage them as importable under their filename instead of blocking them.
    if (this.isGamePsx) {
      return {
        key: path, selected: true,
        path,
        fileName,
        gameId: '',
        gameName: fileName.replace(/\.(cue|iso|bin|zip|vcd)$/i, ''),
        detected: false,
        invalid: false,
        message: 'No commercial serial detected. This disc can be installed using its title.',
      };
    }

    return {
      key: path, selected: true,
      path,
      fileName,
      gameId: '',
      gameName: '',
      detected: false,
      invalid: true,
      message,
    };
  }

  removeStaged(key: string) {
    this.staged = this.staged.filter((f) => f.key !== key);
  }

  clearStaged() {
    this.staged = [];
  }

  importAll() {
    const ready = this.staged.filter(
      (f) => f.selected && (!this.isGamePsx || !f.invalid) && f.gameName && (this.isApp || this.isGamePsx || f.gameId)
    );
    if (!ready.length) {
      return;
    }
    this._jobs.enqueue(
      ready.map((f) => ({
        type: this.importMode,
        label: f.gameName || f.gameId || f.fileName,
        filePath: f.path,
        gameId: f.gameId,
        gameName: f.gameName,
        downloadArtwork: this.downloadArtwork,
        elfPrefix: this.isGamePsx ? this.elfPrefix : undefined,
        launcherMode: this.isGamePsx ? this.launcherMode : undefined,
        archiveEntry: f.archiveEntry,
        keepOriginalName: this.isGameDvd ? this.keepOriginalName : undefined,
      }))
    );
    this.staged = [];
  }
}
