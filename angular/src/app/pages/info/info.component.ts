// Copyright (c) 2026 dnunezx — original LUNA Edition changes.
import { Component } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { BuildInfo } from '../../shared/build-info';

@Component({
  selector: 'app-info',
  imports: [LucideAngularModule],
  templateUrl: './info.component.html',
  styleUrl: './info.component.scss',
})
export class InfoComponent {
  readonly version = BuildInfo.version;
  readonly buildNumber = BuildInfo.buildNumber;
  readonly buildDate = new Date(BuildInfo.buildDate).toLocaleString();
  readonly author = BuildInfo.author;
  readonly upstreamRepoUrl = 'https://github.com/Luden02/OrbitPS2-Manager';
  readonly artRepoUrl = 'https://github.com/Luden02/psx-ps2-opl-art-database';
  readonly psbbnArtRepoUrl = 'https://github.com/CosmicScale/psbbn-art-database';
  readonly licenseUrl =
    'https://github.com/Luden02/OrbitPS2-Manager/blob/main/LICENSE';

  openExternal(url: string, event: Event) {
    event.preventDefault();
    window.open(url, '_blank');
  }
}
