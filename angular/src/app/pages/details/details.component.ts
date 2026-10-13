import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { LibraryService } from '@shared/services/library.service';
import { CfgService, CFG_KEY_NAME } from '@shared/services/cfg.service';
import { TitleCfgService } from '@shared/services/title-cfg.service';
import { Game, gameArt } from '@shared/types/game.type';

@Component({
  selector: 'app-details',
  imports: [LucideAngularModule],
  templateUrl: './details.component.html',
  styleUrl: './details.component.scss',
})
export class DetailsComponent {
  // ── Injected services ─────────────────────────────────────────
  private _router = inject(Router);
  private _library = inject(LibraryService);
  private _cfg = inject(CfgService);
  private _titleCfg = inject(TitleCfgService);
  private _cdr = inject(ChangeDetectorRef);

  // ── Component state ───────────────────────────────────────────

  /** The currently selected game (set in `ngOnInit`). */
  game: Game | null = null;
  /** Base64 data URL for the background art, or `null`. */
  bgArt: string | null = null;
  /** Base64 data URL for the cover art, or `null`. */
  covArt: string | null = null;
  /** Ordered screenshots (SCR first, SCR2 second). */
  screenshots: gameArt[] = [];
  /** Whether title is still being loaded. */
  loading = true;

  /** Game display title (from CFG/title.cfg, falls back to game.title / gameId / filename). */
  displayTitle = '';
  /** Active layout variant, toggled via the header button group. */
  layoutVariant: 'default' | 'alt' = 'default';

  // ── Lifecycle ─────────────────────────────────────────────────

  ngOnInit() {
    this.game = this._library.selectedGameValue;

    if (!this.game) {
      this.loading = false;
      this._cdr.detectChanges();
      return;
    }

    // ── Artwork — sync, safe outside zone ─────────────────────────
    if (Array.isArray(this.game.art)) {
      this.bgArt = this.findBase64Art(this.game.art, 'BG');
      this.covArt = this.findBase64Art(this.game.art, 'COV');
      this.screenshots = this.game.art
        .filter(
          (a) => a.type?.toUpperCase() === 'SCR' || a.type?.toUpperCase() === 'SCR2'
        )
        .sort((a, b) => {
          const order: Record<string, number> = { SCR: 0, SCR2: 1 };
          return (order[a.type?.toUpperCase() ?? ''] ?? 99) - (order[b.type?.toUpperCase() ?? ''] ?? 99);
        });
    }

    // ── Async title — fire-and-forget via .then() + detectChanges() ──
    const root = this._library.currentDirectoryValue;
    if (root) {
      this._loadTitle();
    } else {
      this.loading = false;
      this._cdr.detectChanges();
    }
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Kick off async title loading for the current game.
   *
   * Dispatches to one of three paths depending on the game type:
   * 1. **Disc games** (PS2 / PS1) → `CFG/<gameId>.cfg`
   * 2. **PS1 POPStarter** → `title.cfg`
   * 3. **ELF homebrew** → `title.cfg`
   *
   * Every `.then()` callback assigns state directly and calls
   * `ChangeDetectorRef.detectChanges()` to force Angular change detection,
   * bypassing zone.js microtask tracking (which Electron's
   * `contextBridge` cannot reliably trigger).
   */
  private _loadTitle(): void {
    const game = this.game!;
    const isPs1LauncherApp = game.system === 'APPS' && !!game.isPs1Launcher;
    const isElfApp = game.system === 'APPS' && !game.isPs1Launcher;
    const isDiscGame = !isPs1LauncherApp && !isElfApp && !!game.gameId;

    if (isDiscGame && game.gameId) {
      this._cfg.getGameCfg(game.gameId).then((cfg) => {
        this.displayTitle = cfg[CFG_KEY_NAME] || '';
        this._applyFallbackTitle();
        this.loading = false;
        this._cdr.detectChanges();
      }).catch(() => {
        this._applyFallbackTitle();
        this.loading = false;
        this._cdr.detectChanges();
      });
      return;
    }

    if (isPs1LauncherApp && game.appFolder) {
      this._loadTitleCfg(game.appFolder);
      return;
    }

    if (isElfApp && game.appFolder) {
      this._loadTitleCfg(game.appFolder);
      return;
    }

    this._applyFallbackTitle();
    this.loading = false;
    this._cdr.detectChanges();
  }

  /**
   * Load title from `title.cfg` (POPStarter or ELF apps).
   * Uses the `TitleCfgService` to read and parse the INI-style file.
   */
  private _loadTitleCfg(folder: string): void {
    this._titleCfg.getTitleCfg(folder).then((data) => {
      if (data.title) this.displayTitle = data.title;
      this._applyFallbackTitle();
      this.loading = false;
      this._cdr.detectChanges();
    });
  }

  /**
   * Ensure `displayTitle` has a value.  If no title was loaded from
   * CFG / title.cfg, falls back to `game.title` → `game.gameId` → `game.filename`.
   */
  private _applyFallbackTitle(): void {
    if (!this.displayTitle && this.game) {
      this.displayTitle = this.game.title || this.game.gameId || this.game.filename;
    }
  }

  /** Whether the cover should render in a 1:1 square aspect ratio. */
  get isSquareCover(): boolean {
    if (!this.game) return false;
    return this.game.system === 'PS1' || this.game.system === 'APPS';
  }

  /** `true` when the current game is an ELF homebrew app (not POPStarter). */
  get isElfApp(): boolean {
    return this.game?.system === 'APPS' && !this.game?.isPs1Launcher;
  }

  /**
   * Find the first artwork of the given type and return it as a base64 data URL.
   * Returns `null` if no matching artwork exists.
   */
  private findBase64Art(art: gameArt[], type: string): string | null {
    const found = art.find((a) => a.type?.toUpperCase() === type.toUpperCase());
    return found ? `data:image/png;base64,${found.base64}` : null;
  }

  /**
   * Full launcher path for PS1 POPStarter games, using the OS-native path
   * separator.  Returns `null` for non-PS1-launcher games.
   * E.g. `"APPS\MyGame\LAUNCH.ELF"`
   */
  get launcherFullPath(): string | null {
    const g = this.game;
    if (!g?.isPs1Launcher || !g.ps1LauncherPath) return null;
    const sep = g.ps1LauncherPath.includes('\\') ? '\\' : '/';
    return g.ps1LauncherBoot
      ? `${g.ps1LauncherPath}${sep}${g.ps1LauncherBoot}`
      : g.ps1LauncherPath;
  }

  /** Navigate back to the library, preserving the active system tab. */
  back() {
    if (this.game) {
      const system = this.game.system ?? 'PS2';
      this._library.returnTab = system === 'PS2' ? 'PS2' : system === 'PS1' ? 'PS1' : 'APPS';
    }
    this._library.selectGame(null);
    this._router.navigate(['/library']);
  }
}
