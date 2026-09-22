// Copyright (c) 2026 dnunezx — original LUNA Edition changes.
import PackageInfo from "../../package.json";
import { createLogger } from "../logger";

const log = createLogger("update");

// Set this once OrbitPS2 Manager - LUNA Edition has a public releases repository. Keeping it empty
// prevents the fork from offering unrelated upstream OrbitPS2 releases.
const REPO = "";
const RELEASES_URL = REPO ? `https://api.github.com/repos/${REPO}/releases?per_page=10` : "";

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  releaseName?: string;
  /** Populated when the check itself failed (offline, rate-limited, etc.). */
  error?: string;
}

/** Strips a leading "v" and splits into [core, prerelease]. */
function parseVersion(raw: string): { parts: number[]; pre: string } {
  const cleaned = raw.trim().replace(/^v/i, "");
  const [core, ...preParts] = cleaned.split("-");
  const parts = core.split(".").map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { parts, pre: preParts.join("-") };
}

// Matches this project's prerelease channels (see angular's build-channel.ts):
// e.g. "alpha.0", "beta.1", "rc.2", "release-candidate.0", "indev.3".
const IGNORED_PRERELEASE_PATTERN = /^(alpha|beta|rc|release-?candidate|indev)/i;

/** True if `version`'s prerelease tag is a channel we shouldn't notify about (alpha/beta/rc/indev). */
function isIgnoredPrerelease(version: string): boolean {
  return IGNORED_PRERELEASE_PATTERN.test(parseVersion(version).pre);
}

/**
 * Returns true if `candidate` is a newer version than `current`.
 * Compares the numeric core first; if equal, a build *without* a prerelease
 * tag, or with a lexically-greater one, is considered newer.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] > b.parts[i]) return true;
    if (a.parts[i] < b.parts[i]) return false;
  }
  // Equal core. No prerelease ranks above any prerelease.
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre.localeCompare(b.pre) > 0;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = PackageInfo.version;
  if (!RELEASES_URL) {
    return { updateAvailable: false, currentVersion };
  }
  try {
    log.verbose(`Checking for updates (current v${currentVersion}) at ${RELEASES_URL}`);
    const response = await fetch(RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "OrbitPS2-Manager-LUNA-Edition",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub responded with ${response.status}`);
    }

    const releases = (await response.json()) as Array<{
      tag_name: string;
      name: string;
      html_url: string;
      draft: boolean;
    }>;

    // GitHub returns releases newest-first; take the first published one,
    // skipping alpha/beta/rc/indev prereleases so users aren't nagged about them.
    const latest = releases.find((r) => !r.draft && !isIgnoredPrerelease(r.tag_name));
    if (!latest) {
      log.verbose("No published releases found");
      return { updateAvailable: false, currentVersion };
    }

    const latestVersion = latest.tag_name.replace(/^v/i, "");
    const updateAvailable = isNewerVersion(latest.tag_name, currentVersion);
    log.info(
      updateAvailable
        ? `Update available: v${latestVersion} (current v${currentVersion})`
        : `Up to date (latest v${latestVersion}, current v${currentVersion})`
    );
    return {
      updateAvailable,
      currentVersion,
      latestVersion,
      releaseUrl: latest.html_url,
      releaseName: latest.name || latest.tag_name,
    };
  } catch (error: any) {
    log.error("Update check failed:", error?.message || error);
    return {
      updateAvailable: false,
      currentVersion,
      error: error?.message || String(error),
    };
  }
}
