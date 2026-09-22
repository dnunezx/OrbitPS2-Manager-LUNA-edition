// Copyright (c) 2026 dnunezx — original LUNA Edition changes.
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject,
  OnInit,
} from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { BuildInfo } from '../../build-info';

@Component({
  selector: 'app-title-bar',
  imports: [LucideAngularModule],
  templateUrl: './title-bar.component.html',
  styleUrl: './title-bar.component.scss',
})
export class TitleBarComponent implements OnInit {
  private readonly _destroyRef = inject(DestroyRef);
  private readonly _cdr = inject(ChangeDetectorRef);
  public readonly version = BuildInfo.version;
  public visible = false;
  public maximized = false;
  public canMinimize = false;
  public canMaximize = false;

  ngOnInit() {
    const windowAPI = window.windowAPI;
    if (!windowAPI) return;

    void Promise.all([
      windowAPI.platform(),
      windowAPI.canWindowControls(),
      windowAPI.isMaximized(),
    ]).then(([platform, { canMinimize, canMaximize }, maximized]) => {
      // macOS keeps its native frame/traffic lights; only draw our own
      // title bar where the main process created a frameless window.
      this.visible = platform !== 'darwin';
      this.canMinimize = canMinimize;
      this.canMaximize = canMaximize;
      this.maximized = maximized;
      this._cdr.detectChanges();
    });

    windowAPI.onMaximizedChange((isMaximized) => {
      this.maximized = isMaximized;
      this._cdr.detectChanges();
    });

    this._destroyRef.onDestroy(() =>
      windowAPI.removeAllMaximizedChangeListeners(),
    );
  }

  minimize() {
    window.windowAPI.minimize();
  }

  maximizeToggle() {
    window.windowAPI.maximizeToggle();
  }

  close() {
    window.windowAPI.close();
  }
}
