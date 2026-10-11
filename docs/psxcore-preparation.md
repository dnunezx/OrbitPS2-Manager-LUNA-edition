# LUNA / PSXCore PS1 preparation

Select **PS1 / POPS → LUNA / PSXCore** on the Import screen. The selected
preparation target persists in application settings and travels with each
queued job through preload and Electron IPC.

The desktop prepares discs. Saves, PS1 card creation and card selection are
entirely console responsibilities. There are no desktop card operations.

## Input and conversion

- CUE plus its referenced BIN tracks: raw `MODE1/2352`, `MODE2/2352` and
  `AUDIO`, with `FILE ... BINARY`. Multi-BIN merging retains audio bytes and
  recalculates each file's indexes before conversion.
- BIN selection: resolve the adjacent CUE that actually references that BIN.
  Missing or ambiguous matches require choosing the original CUE.
- ZIP: list all CUE and VCD entries. For several discs, each starts unselected;
  check the wanted discs before queueing. The backend also rejects an archive
  without an explicit selection when it contains several discs.
- Existing VCD: validate, copy and validate again; keep the source intact.

Cooked 2048/2336-byte PS1 sectors, WAVE files, subchannel images, unsupported
indexes, contradictory INDEX 00/PREGAP descriptions and malformed CUEs are
rejected. Renaming a BIN to `.VCD` never satisfies validation.

The converter inserts the actual PREGAP and POSTGAP sector lengths at their
track boundaries, retains embedded INDEX 00 gaps, and applies the 150-sector
absolute-MSF lead-in to track timing and lead-out. It preserves every source
payload byte, including audio. The header's two sector counts, TOC indexes,
lead-out and final size must agree with the emitted payload.

Validation ports the current `PSXCore/src/vcd.c::np_vcd_check` requirements:
A0/A1/A2 TOC, CD-XA first data track, BCD track count, `kHn` version 0x20–0x23,
equal nonzero sector counts, 1 MiB header, 2352-byte sectors, and lead-out equal
to sector count plus 150. It adds bounded, ordered track-table validation and
the `src/file.c` signed 32-bit runtime size limit of 2 GiB minus one byte.

## Resulting drive layout

```text
<selected drive>/
  POPS/
    <GAME_ID>.<Title> (Disc 1).VCD       # when a serial is available
    <GAME_ID>.<Title> (Disc 2).VCD
    <Title>.VCD                        # no commercial serial needed
    <Title> (2).VCD                    # collision suffix, if needed
  ART/                                 # optional artwork
    <GAME_ID>_COV.png
    PSBBN/
      <GAME_ID>.png
```

The disc label is preserved even when database title detection omits it.
Filename comparisons ignore case; collisions append a number in PSXCore
mode. Paths must fit PSXCore's 256-byte disc-path field. No per-game ELF,
`APPS/POPS_*`, card, save directory, runtime or bootstrap is installed by this
mode. Valid serial-free VCDs remain visible under the desktop PS1 tab.

Imports preflight source structure, destination collisions and free space.
ZIP extraction also checks space on the temporary volume. Output is created
in an owned, unique staging folder, synced and validated before publication.
Publication cannot replace an existing file. Filesystems supporting hard
links permit atomic placement; FAT uses an exclusive validated-file copy,
with failed writes cleaned up. All owned staging is removed on normal success
or caught failure. A process kill or device removal can leave staging or an
incomplete FAT copy; no unverified result is reported as successful, and
unrelated directories are never swept automatically.

Existing POPStarter and POPSLoader naming/launcher conventions remain in
their respective modes; imports now report collisions instead of replacing
existing files. Original game sources remain intact in every PS1 mode.

## PSXCore prerequisite status

The setup/status panel is read-only. Select a separately supplied bootstrap,
POPS.ELF and IOPRP252.IMG, or inspect firmware already at `/POPS`. Nothing is
copied or modified. Status does not block disc preparation.

Current source pins these runtime identities:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| POPS.ELF | 3166988 | `59df3389c4df88a572daa720b05507c52c34eddfa0031a6fbeec55e0c2d0fcb1` |
| IOPRP252.IMG | 265233 | `3338b238d84d7d586b716677e3a1c03b2088b882ecfa17f91fc33798931ca3ba` |

An ELF filename or ELF header does not prove revision compatibility. The local
`build/runtime/psxcore-runtime-bootstrap.elf` available during implementation
was built from older copied source than the current v6 contract; its known
SHA-256 is rejected. To verify a newer bootstrap, select a trusted build
fingerprint describing the selected revision:

```json
{
  "revision": "Your verified PSXCore build revision",
  "fileRequestVersion": 6,
  "fileRequestBytes": 1072,
  "bootstrap": { "bytes": 123456, "sha256": "<64 hexadecimal characters from that build>" }
}
```

The size and SHA-256 values must come from that trusted build, not guesses.
The desktop checks the exact fingerprint and ELF32 little-endian MIPS form;
it does not authenticate a fingerprint's publisher. Firmware compatibility
remains pinned to the source revision above.

## Remaining LUNA console dependency

Authoritative local source inspected on 2026-10-11:

- `LUNA/nhddl/src/devices/bdm.c` assigns ordinary ATA/USB device scans to
  `findISO`; add `/POPS/*.VCD` discovery in the ordinary-storage scan path,
  using `np_vcd_check`, PS1 targets, relative disc paths, serial extraction
  when available, stable device identity, and the existing artwork namespace.
- `devices/novapop.c` currently scans the root of `hdd0:__.POPS`, mounted on
  `pfs2:`, rather than `/POPS` on ordinary storage. Keep that legacy source
  separate from direct-file disc inventory.
- `devices/psxcore_disc.c` restricts preparation to `MODE_PS1_APA`/`pfs2:` and
  resolves a prepared partition through the older disc map. Ordinary file
  targets need a v6, 1072-byte `NpFileLaunchRequest` from the current
  `PSXCore/include/psxcore_file.h`, with validated endpoints, image identity,
  runtime root and console-selected existing formatted cards. Card provisioning
  and selection belong to that console flow.
- `nhddl/src/launch.c` returns `LAUNCH_PREVIEW` for PS1; `ui/novapop_preview.c`
  explicitly leaves execution disabled. Add a production PSXCore bootstrap
  path/configuration and handoff, including lifecycle/storage-reset checks,
  rather than routing PS1 through Neutrino. There is currently no authoritative
  bootstrap installation destination to populate from the desktop.
- `PSXCore/runtime/file_storage.c` accepts `--file massN:/POPS/<disc>.VCD`
  or `--file-request <request>`. It actually implements ATA and USB endpoint
  drivers. MX4SIO/MMCE constants alone do not implement those backends.
- `nhddl/src/ui/art_cache.c` uses serial-keyed `/ART/<ID>_COV.png` and
  `/ART/PSBBN/<ID>.png`; direct-file discovery must supply the serial when
  available and retain sensible title/identity behavior without one.

Installed discs are reported as **converted and installed** or **validated and
installed**, with console integration pending. Neither prerequisite checks
nor desktop conversion certify console launch readiness.

## Verification

`npm run test:ps1` builds the backend and runs import and renderer checks.
`powershell -File scripts/test-ps1-native.ps1 -PsxcoreRoot <local PSXCore>`
additionally compiles the unmodified current `src/vcd.c` using WSL Ubuntu and
compares valid and malformed output fixtures against that C validator.

Fixtures cover single-track and multi-BIN/audio conversion, embedded indexes,
actual gaps, reverse-export audio preservation, existing VCD import, multi-disc
archives, malformed images, duplicate/racing destinations, free-space failure,
interrupted writes, FAT fallback, cleanup, settings, queue/preload propagation,
serial-free library visibility, legacy PS1 modes and PS2 CD imports. Preservation
checks use disposable test fixtures only. No supplied games, firmware, cards,
saves, LUNA source or PCSX2 files are modified.

Conversion validation, console handoff validation and physical-PS2 acceptance
are separate. Console launch and physical hardware have not been validated by
this desktop task.

Recorded desktop verification on 2026-10-11: backend build passed; Angular
development and production builds passed; 20 preparation checks and 13 native
PSXCore validator comparisons passed; renderer propagation/library checks and
the existing genre/metadata regression checks passed. Windows filesystem tests
required execution outside the sandbox; the production build required network
access for its existing Google Fonts stylesheet. Native test executables and
disposable fixtures were removed after verification.
