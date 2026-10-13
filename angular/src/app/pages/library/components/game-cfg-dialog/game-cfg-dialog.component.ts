import { ChangeDetectorRef, Component, input, output, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { Game } from '@shared/types/game.type';
import {
  CfgService,
  COMPAT_MODES,
  CFG_KEY_COMPAT,
  CFG_KEY_NAME,
  CFG_KEY_VMC0,
  CFG_KEY_VMC1,
  GameCfg,
  CFG_METADATA_FIELDS,
  cfgMetadataValue,
} from '@shared/services/cfg.service';
import { VmcInfo, VmcService } from '@shared/services/vmc.service';

@Component({
  selector: 'app-game-cfg-dialog',
  imports: [LucideAngularModule],
  templateUrl: './game-cfg-dialog.component.html',
  styleUrl: './game-cfg-dialog.component.scss',
})
export class GameCfgDialogComponent {
  readonly game = input.required<Game>();
  readonly closed = output<void>();

  private readonly _cfg: CfgService;
  private readonly _vmc: VmcService;

  readonly compatModes = COMPAT_MODES;

  entries: GameCfg = {};
  title = '';
  private initialTitle = '';
  compat: boolean[] = new Array(COMPAT_MODES.length).fill(false);
  vmc0 = '';
  vmc1 = '';
  cards: VmcInfo[] = [];
  slot0Cards: VmcInfo[] = [];
  slot1Cards: VmcInfo[] = [];
  loading = signal(true);
  saving = false;
  fetching = false;
  error = '';
  metadataMessage = '';
  readFailed = false;
  readonly metadataFields = CFG_METADATA_FIELDS;
  metadata: GameCfg = {};
  private initialMetadata: GameCfg = {};

  get supportsMetadata(): boolean {
    return !this.game().isPs1Launcher && this.game().system !== 'APPS';
  }

  get canFetchMetadata(): boolean {
    return this.supportsMetadata && (this.game().system ?? 'PS2') === 'PS2';
  }

  private readonly knownKeys = [
    CFG_KEY_NAME,
    CFG_KEY_COMPAT,
    CFG_KEY_VMC0,
    CFG_KEY_VMC1,
    ...CFG_METADATA_FIELDS.map((field) => field.key),
    'Players',
  ];

  constructor(cfg: CfgService, vmc: VmcService, private readonly cdr: ChangeDetectorRef) {
    this._cfg = cfg;
    this._vmc = vmc;
  }

  async ngOnInit() {
    try {
      const g = this.game();
      this.entries = await this._cfg.getGameCfg(g.gameId);
      this.title = this.entries[CFG_KEY_NAME] ?? g.title ?? '';
      this.initialTitle = this.title;
      for (const field of this.metadataFields) this.metadata[field.key] = cfgMetadataValue(this.entries, field.key);
      this.initialMetadata = { ...this.metadata };

      if (g.isPs1Launcher) {
        const vmcSub = g.ps1VmcSub ?? '';
        if (vmcSub) {
          const vmcs = await this._vmc.checkPops(vmcSub);
          if (vmcs.slot0) {
            this.slot0Cards = [{ name: vmcs.slot0, sizeBytes: 0, sizeMb: 0 }];
            this.vmc0 = vmcs.slot0;
          }
          if (vmcs.slot1) {
            this.slot1Cards = [{ name: vmcs.slot1, sizeBytes: 0, sizeMb: 0 }];
            this.vmc1 = vmcs.slot1;
          }
        }
      } else {
        this.cards = await this._vmc.refresh();
        this.vmc0 = this.entries[CFG_KEY_VMC0] ?? '';
        this.vmc1 = this.entries[CFG_KEY_VMC1] ?? '';
      }

      if (!g.isPs1Launcher) {
        const compatVal = parseInt(this.entries[CFG_KEY_COMPAT] ?? '0', 10) || 0;
        this.compat = this.compatModes.map(
          (m) => (compatVal & (1 << m.bit)) !== 0,
        );
      }
    } catch (error) {
      this.readFailed = true;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading.set(false);
      this.cdr.markForCheck();
    }
  }

  get cardNames(): string[] {
    const names = new Set(this.cards.map((c) => c.name));
    if (this.vmc0) names.add(this.vmc0);
    if (this.vmc1) names.add(this.vmc1);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }

  get slot0Names(): string[] {
    return this.slot0Cards.map((c) => c.name);
  }

  get slot1Names(): string[] {
    return this.slot1Cards.map((c) => c.name);
  }

  get otherKeyCount(): number {
    return Object.keys(this.entries).filter((key) => !this.knownKeys.some((known) =>
      known.replace(/^#/, '').toLowerCase() === key.replace(/^#/, '').toLowerCase()))
      .length;
  }

  get hasChanges(): boolean {
    if (this.readFailed || this.fetching) return false;
    if (this.game().isPs1Launcher) {
      const trimmed = this.title.trim();
      return trimmed !== '' && trimmed !== this.initialTitle;
    }
    return true;
  }

  async fillMissingMetadata(): Promise<void> {
    if (!this.canFetchMetadata || this.fetching || this.saving || this.readFailed) return;
    this.fetching = true;
    this.error = '';
    this.metadataMessage = '';
    try {
      const downloaded = await this._cfg.lookupMetadata(this.game().gameId);
      let filled = 0;
      for (const field of this.metadataFields) {
        const value = cfgMetadataValue(downloaded, field.key);
        if (!this.metadata[field.key]?.trim() && value) {
          this.metadata[field.key] = field.key === 'Description' ? value.slice(0, 255) : value;
          filled++;
        }
      }
      this.metadataMessage = filled ? `Filled ${filled} field(s). Save to write them to the library drive.` :
        'No additional metadata is available for this game ID. You can enter it manually.';
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.fetching = false;
      this.cdr.markForCheck();
    }
  }

  private applyMetadata(next: GameCfg): void {
    if (!this.supportsMetadata) return;
    for (const field of this.metadataFields) {
      const value = (this.metadata[field.key] || '').replace(/[\r\n]+/g, ' ').trim();
      // Preserve untouched legacy fields verbatim, including long descriptions.
      if (value === this.initialMetadata[field.key]) continue;
      for (const key of Object.keys(next)) {
        const canonical = key.replace(/^#/, '').toLowerCase();
        if (canonical === field.key.toLowerCase() || (field.key === 'PlayersText' && canonical === 'players')) delete next[key];
      }
      if (value) next[field.key] = value;
      if (field.key === 'PlayersText' && value) {
        const counts = value.match(/\d+/g)?.map(Number) ?? [];
        if (counts.length) next['Players'] = `players/${Math.max(...counts)}`;
      }
    }
  }

  async save() {
    if (this.saving || !this.hasChanges) return;
    this.saving = true;
    this.error = '';
    try {
      const next: GameCfg = { ...this.entries };
      this.applyMetadata(next);
      const trimmed = this.title.trim();
      if (trimmed) next[CFG_KEY_NAME] = trimmed;
      else delete next[CFG_KEY_NAME];

      const g = this.game();
      if (g.isPs1Launcher) {
        delete next[CFG_KEY_COMPAT];
        delete next[CFG_KEY_VMC0];
        delete next[CFG_KEY_VMC1];
        if (!await this._cfg.saveGameCfg(g.gameId, next, this.entries)) throw new Error('Unable to save CFG to the library drive.');
        if (g.ps1LauncherPath) {
          await window.libraryAPI.updatePs1TitleCfg(g.ps1LauncherPath, trimmed || g.gameId, g.gameId);
        }
        this.closed.emit();
        return;
      }

      let mask = 0;
      this.compatModes.forEach((m, i) => {
        if (this.compat[i]) mask |= 1 << m.bit;
      });
      if (mask > 0) next[CFG_KEY_COMPAT] = String(mask);
      else delete next[CFG_KEY_COMPAT];

      if (this.vmc0) next[CFG_KEY_VMC0] = this.vmc0;
      else delete next[CFG_KEY_VMC0];
      if (this.vmc1) next[CFG_KEY_VMC1] = this.vmc1;
      else delete next[CFG_KEY_VMC1];

      if (!await this._cfg.saveGameCfg(g.gameId, next, this.entries)) throw new Error('Unable to save CFG to the library drive.');
      this.closed.emit();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.saving = false;
      this.cdr.markForCheck();
    }
  }

  onCompatChange(index: number, event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (input) this.compat[index] = input.checked;
  }

  close() {
    if (this.saving || this.fetching) return;
    this.closed.emit();
  }
}
