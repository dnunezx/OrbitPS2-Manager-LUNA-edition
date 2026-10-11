import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { LibraryService } from '@shared/services/library.service';
import { CfgService, CFG_KEY_NAME, cfgMetadataValue } from '@shared/services/cfg.service';
import { TitleCfgService } from '@shared/services/title-cfg.service';
import { Game, gameArt } from '@shared/types/game.type';

/**
 * Details view for a single game or app.
 *
 * Displays cover art, metadata (title, developer, genre, release, score,
 * parental rating, players), description, screenshots, and file info.
 *
 * Supports two layout variants: **default** (stacked) and **alt** (card-style
 * with a 2-column meta grid), toggled via the header button group.
 *
 * Metadata sources:
 * - **PS2 / PS1 disc games** → `CFG/<gameId>.cfg`
 * - **PS1 POPStarter (APPS)** → `APPS/<folder>/title.cfg`
 * - **ELF homebrew (APPS)** → `title.cfg` (some fields hidden)
 *
 * ── Change detection ──────────────────────────────────────────────
 * Uses `ChangeDetectionStrategy.Default` and calls
 * `ChangeDetectorRef.detectChanges()` after every async state assignment
 * because zone.js cannot reliably track Promise microtasks across
 * Electron's `contextBridge` boundary.
 */
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
  /** Whether metadata is still being loaded. */
  loading = true;

  /** Game display title (from CFG/title.cfg, falls back to game.title / gameId / filename). */
  displayTitle = '';
  /** Developer string, hidden for ELF apps. */
  developer = '';
  /** Genre string, hidden for ELF apps. */
  genre = '';
  /** Release year string, hidden for ELF apps. */
  release = '';
  /** Game description / synopsis. */
  description = '';
  /** Numeric score (0–5) used for the star icons. */
  ratingValue = 0;
  /** Parental rating system type extracted from `Parental=<type>/<value>` (e.g. `"esrb"`). */
  parentalType = '';
  /** Parental rating display value extracted from `ParentalText` (e.g. `"T"`). */
  parentalDisplayValue = '';
  /** Raw players string (e.g. `"1-4"`, `"2"`). */
  players = '';
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

    // ── Async metadata — fire-and-forget via .then() + detectChanges() ──
    const root = this._library.currentDirectoryValue;
    if (root) {
      this._loadMetadata(root);
    } else {
      this.loading = false;
      this._cdr.detectChanges();
    }
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Kick off async metadata loading for the current game.
   *
   * Dispatches to one of three paths depending on the game type:
   * 1. **Disc games** (PS2 / PS1) → `CFG/<gameId>.cfg`
   * 2. **PS1 POPStarter** → `title.cfg`
   * 3. **ELF homebrew** → `title.cfg` (with field restrictions)
   *
   * Every `.then()` callback assigns state directly and calls
   * `ChangeDetectorRef.detectChanges()` to force Angular change detection,
   * bypassing zone.js microtask tracking (which Electron's
   * `contextBridge` cannot reliably trigger).
   */
  private _loadMetadata(root: string): void {
    const game = this.game!;
    const isPs1LauncherApp = game.system === 'APPS' && !!game.isPs1Launcher;
    const isElfApp = game.system === 'APPS' && !game.isPs1Launcher;
    const isDiscGame = !isPs1LauncherApp && !isElfApp && !!game.gameId;

    if (isDiscGame && game.gameId) {
      this._cfg.getGameCfg(game.gameId).then((cfg) => {
        this.displayTitle = cfg[CFG_KEY_NAME] || '';
        this.developer = cfgMetadataValue(cfg, 'Developer');
        this.genre = cfgMetadataValue(cfg, 'Genre');
        this.release = cfgMetadataValue(cfg, 'Release');
        this.description = cfgMetadataValue(cfg, 'Description');
        this.ratingValue = this.parseRating(cfg['RatingText'] || cfg['Rating'] || '');
        this._formatParentalLabel(cfg['Parental'] || '', cfg['ParentalText'] || '');
        this.players = cfgMetadataValue(cfg, 'PlayersText');
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
   * Load metadata from `title.cfg` (POPStarter or ELF apps).
   * Uses the `TitleCfgService` to read and parse the INI-style file.
   */
  private _loadTitleCfg(folder: string): void {
    this._titleCfg.getTitleCfg(folder).then((data) => {
      if (data.title) this.displayTitle = data.title;
      if (data.developer) this.developer = data.developer;
      if (data.genre) this.genre = data.genre;
      if (data.release) this.release = data.release;
      if (data.description) this.description = data.description;
      if (data.ratingText || data.rating) {
        this.ratingValue = this.parseRating(data.ratingText || data.rating || '');
      }
      if (data.parental || data.parentalText) {
        this._formatParentalLabel(data.parental || '', data.parentalText || '');
      }
      if (data.playersText) this.players = data.playersText;
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

  /**
   * Parse the `Parental` and `ParentalText` CFG values into separate
   * component properties consumed by the `parentalLabel` getter.
   *
   * Examples:
   * - `Parental="esrb/teen"`, `ParentalText="T"` → type=`"esrb"`, value=`"T"`
   * - `Parental="pegi/12"` (no ParentalText) → type=`"pegi"`, value=`"12"`
   * - `ParentalText="T"` alone → type=`""`, value=`"T"`
   */
  private _formatParentalLabel(parental: string, text: string): void {
    if (parental.includes('/')) {
      this.parentalType = parental.split('/')[0].trim();
      this.parentalDisplayValue = text || parental.split('/')[1].trim();
    } else {
      this.parentalType = '';
      this.parentalDisplayValue = text || parental;
    }
  }

  // ── Template helpers ──────────────────────────────────────────────

  /**
   * Formatted parental rating string for display.
   *
   * Returns `""` when no rating is available.
   * Examples: `"ESRB - T"`, `"PEGI - 12"`, `"CERO - A"`, or just `"T"` if the
   * parental type is unknown.
   */
  get parentalLabel(): string {
    if (!this.parentalType && !this.parentalDisplayValue) return '';
    if (!this.parentalType) return this.parentalDisplayValue;
    return `${this.parentalType.toUpperCase()} - ${this.parentalDisplayValue}`;
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
   * Boolean array of length 5 for the star-rating template.
   *
   * Each entry is `true` (filled star) or `false` (empty) based on
   * `ratingValue`.  Generated so the template can iterate with `@for`.
   */
  get ratingStars(): boolean[] {
    const r = Math.round(this.ratingValue);
    return [1, 2, 3, 4, 5].map((i) => i <= r);
  }

  /**
   * Number of players, extracted from the raw players string and clamped
   * to 1–4.  Used to render the correct number of filled user icons.
   *
   * Examples: `"1-4"` → 4, `"2"` → 2, `""` → 0.
   */
  get playersCount(): number {
    if (!this.players) return 0;
    const counts = this.players.match(/\d+/g)?.map(Number) ?? [];
    return counts.length ? Math.min(Math.max(...counts), 4) : 0;
  }

  /**
   * Convert a raw `Rating` / `RatingText` CFG value to a numeric score (0–5).
   *
   * Handles both formats defined in the CFG Editor Docs:
   * - `Rating=rating/<number>` — strips the `rating/` prefix
   * - `RatingText=<number>` — used as-is
   *
   * Non-numeric or missing input returns 0.
   */
  private parseRating(raw: string): number {
    if (!raw) return 0;
    const trimmed = raw.trim();
    const slashIdx = trimmed.lastIndexOf('/');
    const numStr = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
    const num = Number(numStr);
    return !isNaN(num) ? Math.min(Math.max(num, 0), 5) : 0;
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
