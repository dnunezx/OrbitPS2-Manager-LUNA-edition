// Copyright (c) 2026 dnunezx — original LUNA Edition changes.
import { Component, computed, input, output, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { Game } from '@shared/types/game.type';
import { JobsService } from '@shared/services/jobs.service';
import { LibraryService } from '@shared/services/library.service';
import {
  ARTWORK_PRESETS,
  artTypeLabel,
} from '@shared/constants/artwork-presets';

interface ArtworkOption {
  type: string;
  label: string;
  downloadUrl: string;
  alreadySaved: boolean;
}

@Component({
  selector: 'app-artwork-wizard-dialog',
  imports: [LucideAngularModule],
  templateUrl: './artwork-wizard-dialog.component.html',
  styleUrl: './artwork-wizard-dialog.component.scss',
})
export class ArtworkWizardDialogComponent {
  readonly game = input.required<Game>();
  readonly closed = output<void>();

  readonly presets = ARTWORK_PRESETS;
  readonly artTypeLabel = artTypeLabel;

  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly options = signal<ArtworkOption[]>([]);
  readonly selected = signal<Set<string>>(new Set());
  readonly skipExisting = signal(false);
  readonly importingCustom = signal(false);
  readonly importMessage = signal<string | null>(null);

  readonly selectedCount = computed(() => this.selected().size);

  constructor(
    private readonly _jobs: JobsService,
    private readonly _library: LibraryService,
  ) {}

  private get isPs1Launcher(): boolean {
    return !!this.game().isPs1Launcher;
  }

  private get system(): 'PS1' | 'PS2' {
    return this.game().system === 'PS1' || this.isPs1Launcher ? 'PS1' : 'PS2';
  }

  get supportsPsbbn(): boolean {
    return this.system === 'PS2';
  }

  private get localName(): string {
    return this.isPs1Launcher
      ? this.game().ps1LauncherBoot || this.game().gameId
      : this.game().gameId;
  }

  async ngOnInit() {
    const g = this.game();
    const result = await window.libraryAPI.listAvailableArt(g.gameId, this.system);

    if (!result?.success) {
      this.errorMessage.set(result?.message || 'Failed to load available artwork.');
    }

    const dirPath = this._library.currentDirectoryValue;
    const localName = this.localName;
    const available = result?.data ?? [];
    const localFileForType = (type: string) =>
      type === 'PSBBN' ? `PSBBN/${g.gameId}.png` : `${localName}_${type}.png`;
    const expectedFiles = available.map((d) => localFileForType(d.type));
    const existing = dirPath
      ? await window.libraryAPI.checkArtFilesExist(`${dirPath}/ART`, expectedFiles)
      : [];

    this.options.set(
      available.map((d) => ({
        type: d.type,
        label: artTypeLabel(d.type),
        downloadUrl: d.downloadUrl,
        alreadySaved: existing.includes(localFileForType(d.type)),
      })),
    );
    this.selected.set(new Set(available.map((d) => d.type)));
    this.loading.set(false);
  }

  async importCustomPsbbn(): Promise<void> {
    const dirPath = this._library.currentDirectoryValue;
    const g = this.game();
    if (!dirPath || !g.gameId) return;

    this.importingCustom.set(true);
    this.importMessage.set(null);
    try {
      const result = await window.libraryAPI.importCustomPsbbnArt(dirPath, g.gameId);
      if (result.cancelled) return;
      if (!result.success) {
        this.importMessage.set(result.message || 'Could not import the selected image.');
        return;
      }

      const current = this.options();
      const found = current.find((option) => option.type === 'PSBBN');
      this.options.set(
        found
          ? current.map((option) =>
              option.type === 'PSBBN'
                ? { ...option, alreadySaved: true, downloadUrl: result.dataUrl || option.downloadUrl }
                : option,
            )
          : [
              ...current,
              {
                type: 'PSBBN',
                label: artTypeLabel('PSBBN'),
                downloadUrl: result.dataUrl || '',
                alreadySaved: true,
              },
            ],
      );
      this.importMessage.set('Custom PSBBN jacket saved as a 256x256 PNG.');
      await this._library.updateArtForGame(g.gameId);
    } catch (error: any) {
      this.importMessage.set(error?.message || 'Could not import the selected image.');
    } finally {
      this.importingCustom.set(false);
    }
  }

  isSelected(type: string): boolean {
    return this.selected().has(type);
  }

  toggle(type: string): void {
    const next = new Set(this.selected());
    if (next.has(type)) next.delete(type);
    else next.add(type);
    this.selected.set(next);
  }

  applyPreset(types: string[] | null): void {
    const available = this.options().map((o) => o.type);
    const next = types === null ? available : types.filter((t) => available.includes(t));
    this.selected.set(new Set(next));
  }

  selectAll(): void {
    this.selected.set(new Set(this.options().map((o) => o.type)));
  }

  deselectAll(): void {
    this.selected.set(new Set());
  }

  download(): void {
    const g = this.game();
    const types = Array.from(this.selected());
    if (types.length === 0) return;

    this._jobs.enqueue([
      {
        type: 'artwork',
        label: g.title || g.gameId || g.filename,
        filePath: g.path,
        gameId: g.gameId,
        gameName: g.title || '',
        downloadArtwork: false,
        system: this.system,
        saveAsName: this.isPs1Launcher ? g.ps1LauncherBoot : undefined,
        artTypes: types,
        skipExisting: this.skipExisting(),
      },
    ]);
    this.close();
  }

  close(): void {
    this.closed.emit();
  }
}
