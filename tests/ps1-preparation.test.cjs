const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { Writable } = require('node:stream');
const AdmZip = require('adm-zip');

let appRoot = fsSync.mkdtempSync(path.join(__dirname, '.luna-ps1-test-')), artworkCalls = [];
const originalLoad = Module._load;
Module._load = function(name, parent, main) {
  if (name === 'electron') return { app: { getAppPath: () => appRoot, getPath: () => appRoot } };
  if (name === './artwork.service') return { downloadArtByGameId: async (...args) => artworkCalls.push(args) };
  return originalLoad.call(this, name, parent, main);
};
const { convertToVcd, convertVcdToBin } = require('../dist/src/utils/cue2pops');
const { validateVcd, checkVcdHeader } = require('../dist/src/utils/psxcore-vcd');
const { importPs1Game } = require('../dist/src/services/ps1-import.service');
const { inspectPs1Source } = require('../dist/src/services/ps1-source.service');
const { mergeMultiBin } = require('../dist/src/utils/binmerge');
const { parseCueSheet } = require('../dist/src/utils/cue-parser');
const { importPs2CdGame } = require('../dist/src/services/cd-import.service');
const { publishFile, requireSpace } = require('../dist/src/utils/safe-install');
const { getPsxcoreStatus, verifyPsxcoreFile } = require('../dist/src/services/psxcore-status.service');
const { getSettings, setSetting } = require('../dist/src/services/settings.service');
const { deleteGameAndRelatedFiles } = require('../dist/src/services/delete.service');
const { normalizeRiptOplPs1Storage } = require('../dist/src/services/rename.service');

const sectorSize = 2352, headerSize = 0x100000;
function raw(n, audio = false) {
  const data = Buffer.alloc(n * sectorSize, audio ? 0x39 : 0x51);
  if (!audio) for (let i = 0; i < n; i++) {
    const at = i * sectorSize; data.fill(0xff, at + 1, at + 11); data[at] = data[at + 11] = 0; data[at + 15] = 2;
  }
  return data;
}
const bcd = v => (v >> 4) * 10 + (v & 15);
const timestamp = (h, o) => bcd(h[o]) * 4500 + bcd(h[o + 1]) * 75 + bcd(h[o + 2]);
let checks = 0, nativeChecks = 0;
async function test(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
async function absent(file) { await assert.rejects(fs.access(file)); }
async function noTemps(root) { assert(!(await fs.readdir(path.join(root, 'POPS'))).some(n => n.startsWith('.luna-import-'))); }
async function nativeCheck(file, expected = true) {
  if (!process.env.PSXCORE_NATIVE_VALIDATOR) return;
  const linux = '/mnt/' + file[0].toLowerCase() + file.slice(2).replace(/\\/g, '/');
  const result = spawnSync('wsl', ['-d', 'Ubuntu-24.04', '--', process.env.PSXCORE_NATIVE_VALIDATOR, linux], { encoding: 'utf8' });
  assert.equal(result.status === 0, expected, result.stderr || result.stdout); nativeChecks++;
}
async function file(root, name, data) { const p = path.join(root, name); await fs.writeFile(p, data); return p; }
async function importDisc(source, root, title, mode = 'psxcore', entry, art = false) {
  return importPs1Game(source, root, 'XX.', art, undefined, title, mode, undefined, entry);
}

(async () => {
  const root = appRoot;
  const source = path.join(root, 'sources'), drive = path.join(root, 'drive');
  await fs.mkdir(source); await fs.mkdir(drive); await fs.mkdir(path.join(root, 'assets'));
  await file(path.join(root, 'assets'), 'POPSTARTER.ELF', Buffer.from('test launcher'));
  try {
    const bin = await file(source, 'Single.bin', raw(8));
    const cue = await file(source, 'Single.cue', 'FILE "Single.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00\n');
    const single = path.join(source, 'Single.VCD');
    await test('single-track header, exact payload, native validator', async () => {
      await convertToVcd(bin, cue, single);
      const info = await validateVcd(single), data = await fs.readFile(single);
      assert.equal(info.sectors, 8); assert.equal(info.tracks, 1);
      assert.equal(data.length, headerSize + 8 * sectorSize); assert.equal(timestamp(data, 27), 158);
      assert.equal(timestamp(data, 37), 150); assert.deepEqual(data.subarray(headerSize), await fs.readFile(bin));
      await nativeCheck(single);
    });
    const multiBin = await file(source, 'Mixed.bin', Buffer.concat([raw(8), raw(7, true)]));
    const multiCue = await file(source, 'Mixed.cue', 'FILE "Mixed.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00\n POSTGAP 00:00:02\n TRACK 02 AUDIO\n PREGAP 00:00:03\n INDEX 01 00:00:08\n POSTGAP 00:00:04\n');
    const mixed = path.join(source, 'Mixed.VCD');
    await test('actual PREGAP/POSTGAP lengths, audio bytes, indexes and lead-out', async () => {
      await convertToVcd(multiBin, multiCue, mixed);
      const d = await fs.readFile(mixed);
      assert.equal((await validateVcd(mixed)).sectors, 24); assert.equal(d[40], 1);
      assert.equal(timestamp(d, 43), 160); assert.equal(timestamp(d, 47), 163); assert.equal(timestamp(d, 27), 174);
      assert.deepEqual(d.subarray(headerSize, headerSize + 8 * sectorSize), raw(8));
      assert(d.subarray(headerSize + 8 * sectorSize, headerSize + 13 * sectorSize).every(v => v === 0));
      assert.deepEqual(d.subarray(headerSize + 13 * sectorSize, headerSize + 20 * sectorSize), raw(7, true));
      assert(d.subarray(headerSize + 20 * sectorSize).every(v => v === 0)); await nativeCheck(mixed);
    });
    await test('embedded INDEX 00 is preserved without extra gap insertion', async () => {
      const c = await file(source, 'Embedded.cue', 'FILE "Mixed.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n INDEX 00 00:00:06\n INDEX 01 00:00:08\n');
      const v = path.join(source, 'Embedded.VCD'); await convertToVcd(multiBin, c, v);
      const d = await fs.readFile(v); assert.equal((await validateVcd(v)).sectors, 15);
      assert.equal(timestamp(d, 43), 156); assert.equal(timestamp(d, 47), 158);
      assert.deepEqual(d.subarray(headerSize), await fs.readFile(multiBin)); await nativeCheck(v);
    });
    await test('multi-BIN merge recalculates indexes and preserves audio', async () => {
      await file(source, 'Audio.bin', raw(7, true));
      const c = await file(source, 'Multi.cue', 'file "single.BIN" binary\n track 01 mode2/2352\n index 01 00:00:00\n FILE "Audio.bin" BINARY\n TRACK 02 AUDIO\n INDEX 01 00:00:00\n');
      const target = path.join(root, 'merge'); await fs.mkdir(target);
      const merged = await mergeMultiBin(c, target), parsed = await parseCueSheet(merged.mergedCuePath);
      assert.equal(parsed.files[0].tracks[1].indexes[0].frames, 8);
      assert.deepEqual(await fs.readFile(merged.mergedBinPath), Buffer.concat([raw(8), raw(7, true)]));
      const result = await importDisc(c, drive, 'Audio Game'); assert(result.success, result.message);
      await nativeCheck(result.vcdPath); await noTemps(drive);
    });
    await test('VCD reverse conversion preserves silence and every audio byte', async () => {
      const out = path.join(root, 'export'); await fs.mkdir(out);
      const result = await convertVcdToBin(mixed, path.join(out, 'mixed.bin'), path.join(out, 'mixed.cue'));
      assert.equal(result.trackCount, 2); assert.equal(result.hadGap, true);
      assert.deepEqual(await fs.readFile(path.join(out, 'mixed.bin')), (await fs.readFile(mixed)).subarray(headerSize));
      const roundtrip = path.join(out, 'roundtrip.VCD'); await convertToVcd(path.join(out, 'mixed.bin'), path.join(out, 'mixed.cue'), roundtrip);
      assert.deepEqual(await fs.readFile(roundtrip), await fs.readFile(mixed)); await nativeCheck(roundtrip);
    });
    await test('existing VCD import copies, validates, preserves original; no launcher', async () => {
      const before = await fs.readFile(single), r = await importDisc(single, drive, 'My Game (Disc 1)');
      assert(r.success, r.message); assert.equal(r.readyToLaunch, false); assert.match(r.message, /Validated and installed/);
      assert.deepEqual(await fs.readFile(r.vcdPath), before); assert.deepEqual(await fs.readFile(single), before);
      assert.equal(path.dirname(r.vcdPath), path.join(drive, 'POPS')); await absent(path.join(drive, 'APPS'));
    });
    await test('case-insensitive duplicate names are collision-safe, never overwritten', async () => {
      const first = await importDisc(cue, drive, 'Collision'); assert(first.success, first.message);
      const before = await fs.readFile(first.vcdPath);
      const second = await importDisc(cue, drive, 'collision'); assert(second.success, second.message);
      assert.match(second.vcdPath, /collision \(2\)\.VCD$/); assert.deepEqual(await fs.readFile(first.vcdPath), before);
      await assert.rejects(convertToVcd(bin, cue, first.vcdPath), /EEXIST/); assert.deepEqual(await fs.readFile(first.vcdPath), before);
    });
    await test('BIN selections resolve their matching CUE; unmatched/ambiguous fail clearly', async () => {
      const pairDir = path.join(source, 'pair'); await fs.mkdir(pairDir);
      const pairedBin = await file(pairDir, 'Single.bin', raw(8));
      const pairedCue = await file(pairDir, 'Single.cue', await fs.readFile(cue));
      assert.equal((await inspectPs1Source(pairedBin)).path, pairedCue);
      const orphan = await file(pairDir, 'Orphan.bin', raw(1)); await assert.rejects(inspectPs1Source(orphan), /track types, indexes and audio/);
      const another = await file(pairDir, 'Another.cue', await fs.readFile(cue));
      await assert.rejects(inspectPs1Source(pairedBin), /Several CUE/); await fs.unlink(another);
    });
    await test('multi-disc ZIP lists CUE/VCD choices and never picks the first disc silently', async () => {
      const zip = new AdmZip(); zip.addFile('Disc 1/Game.cue', Buffer.from('FILE "Game.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00\n'));
      zip.addFile('Disc 1/Game.bin', raw(8)); zip.addFile('Disc 2/Game.VCD', await fs.readFile(single));
      const p = path.join(source, 'TwoDiscs.zip'); zip.writeZip(p);
      assert.deepEqual((await inspectPs1Source(p)).discs, ['Disc 1/Game.cue', 'Disc 2/Game.VCD']);
      const bad = await importDisc(p, drive, 'Game'); assert.equal(bad.success, false); assert.match(bad.message, /Select a disc/);
      for (const [entry, disc] of [['Disc 1/Game.cue', 1], ['Disc 2/Game.VCD', 2]]) {
        const r = await importDisc(p, drive, 'Game', 'psxcore', entry); assert(r.success, r.message);
        assert.match(r.vcdPath, new RegExp('Disc ' + disc)); await nativeCheck(r.vcdPath);
      }
      const dirs = await fs.readdir(os.tmpdir()); assert(!dirs.some(n => n.startsWith('luna-ps1-zip-')));
      await noTemps(drive);
    });
    await test('unsupported formats and malformed CUEs are rejected before installing', async () => {
      for (const [name, text] of [
        ['Cooked', 'FILE "Single.bin" BINARY\n TRACK 01 MODE1/2048\n INDEX 01 00:00:00'],
        ['Wave', 'FILE "Single.bin" WAVE\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00'],
        ['NoIndex', 'FILE "Single.bin" BINARY\n TRACK 01 MODE2/2352'],
        ['BadTime', 'FILE "Single.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:61:00'],
        ['AmbiguousGap', 'FILE "Mixed.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n PREGAP 00:00:03\n INDEX 00 00:00:06\n INDEX 01 00:00:08'],
        ['Traversal', 'FILE "../Single.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00'],
      ]) {
        const p = await file(source, name + '.cue', text); const r = await importDisc(p, drive, name);
        assert.equal(r.success, false, name); await absent(path.join(drive, 'POPS', name + '.VCD'));
      }
      const p = await file(source, 'Truncated.bin', Buffer.alloc(2353));
      const c = await file(source, 'Truncated.cue', 'FILE "Truncated.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00');
      assert.equal((await importDisc(c, drive, 'Truncated')).success, false); await noTemps(drive);
    });
    await test('malformed archives and extraction/import failures leave no owned temporary files', async () => {
      const before = (await fs.readdir(os.tmpdir())).filter(n => n.startsWith('luna-ps1-zip-')).sort();
      const broken = new AdmZip(); broken.addFile('Missing.cue', Buffer.from('FILE "missing.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00'));
      const p = path.join(source, 'Broken.zip'); broken.writeZip(p);
      assert.equal((await importDisc(p, drive, 'Missing')).success, false);
      assert.deepEqual((await fs.readdir(os.tmpdir())).filter(n => n.startsWith('luna-ps1-zip-')).sort(), before);
      const unsafe = new AdmZip(); unsafe.addFile('invalid:disc.cue', Buffer.from('invalid'));
      const q = path.join(source, 'Unsafe.zip'); unsafe.writeZip(q); await assert.rejects(inspectPs1Source(q), /unsafe paths/);
      const duplicate = new AdmZip(); duplicate.addFile('Game.cue', Buffer.from('invalid')); duplicate.addFile('game.CUE', Buffer.from('invalid'));
      const d = path.join(source, 'Duplicate.zip'); duplicate.writeZip(d); await assert.rejects(inspectPs1Source(d), /duplicate paths/);
      const failed = await importPs1Game(cue, drive, 'XX.', false, undefined, 'Interrupted Import', 'psxcore', percent => {
        if (percent >= 35) throw new Error('interrupted import');
      });
      assert.equal(failed.success, false); assert.match(failed.message, /interrupted import/); await noTemps(drive);
      await absent(path.join(drive, 'POPS', 'Interrupted Import.VCD'));
    });
    await test('VCD rejects bad TOC, marker, counts, lead-out, alignment, runtime limit', async () => {
      const data = await fs.readFile(single);
      for (const [name, mutate] of [
        ['toc', d => d[2] = 0], ['marker', d => d[1024] = 0], ['version', d => d[1027] = 0x24],
        ['count', d => d.writeUInt32LE(9, 1032)], ['leadout', d => d[29] = 0], ['tracks', d => d[32] = 3],
      ]) {
        const changed = Buffer.from(data); mutate(changed); const p = await file(source, name + '.VCD', changed);
        await assert.rejects(validateVcd(p)); const r = await importDisc(p, drive, 'Invalid'); assert.equal(r.success, false);
        if (name !== 'tracks') await nativeCheck(p, false);
      }
      const p = await file(source, 'Unaligned.VCD', data.subarray(0, data.length - 1)); await assert.rejects(validateVcd(p)); await nativeCheck(p, false);
      const renamed = await file(source, 'Renamed.VCD', raw(8)); await assert.rejects(validateVcd(renamed));
      const huge = Buffer.from(data.subarray(0, headerSize)), count = Math.ceil((0x80000000 - headerSize) / sectorSize);
      huge.writeUInt32LE(count, 1032); huge.writeUInt32LE(count, 1036);
      assert.throws(() => checkVcdHeader(huge, headerSize + count * sectorSize), /runtime size limit/);
    });
    await test('interrupted conversion and publication failure remove only owned output', async () => {
      const p = path.join(source, 'Interrupted.VCD');
      await assert.rejects(convertToVcd(bin, cue, p, () => { throw new Error('simulated cancellation'); }), /simulated/);
      await absent(p); assert.deepEqual(await fs.readFile(bin), raw(8));
      const destination = path.join(drive, 'POPS', 'Failed.VCD');
      await assert.rejects(publishFile(single, destination, async () => { throw new Error('verification interruption'); }), /verification interruption/);
      await absent(destination); await validateVcd(single);
      const statfs = fs.statfs; fs.statfs = async () => ({ bavail: 0, bsize: 4096 });
      try { await assert.rejects(requireSpace(drive, 1), /Insufficient/); assert.equal((await importDisc(cue, drive, 'NoSpace')).success, false); }
      finally { fs.statfs = statfs; }
      await absent(path.join(drive, 'POPS', 'NoSpace.VCD')); await noTemps(drive);
    });
    await test('FAT exclusive-copy fallback handles failures and destination races safely', async () => {
      const originalLink = fs.link, originalWrite = fsSync.createWriteStream;
      const good = path.join(drive, 'POPS', 'Fat.VCD'), bad = path.join(drive, 'POPS', 'FailedFat.VCD');
      fs.link = async () => { const e = new Error('FAT has no hard links'); e.code = 'ENOTSUP'; throw e; };
      try {
        await publishFile(single, good, validateVcd); assert.deepEqual(await fs.readFile(good), await fs.readFile(single));
        fsSync.createWriteStream = (name, options) => name === bad ? new Writable({ write(_chunk, _encoding, done) { done(new Error('simulated device disconnect')); } }) : originalWrite(name, options);
        await assert.rejects(publishFile(single, bad, validateVcd), /device disconnect/); await absent(bad);
      } finally { fs.link = originalLink; fsSync.createWriteStream = originalWrite; }
      const raced = path.join(drive, 'POPS', 'Race.VCD');
      fs.link = async (from, to) => { await fs.writeFile(to, 'another import owns this', { flag: 'wx' }); return originalLink(from, to); };
      try { await assert.rejects(publishFile(single, raced, validateVcd), /EEXIST/); assert.equal((await fs.readFile(raced)).toString(), 'another import owns this'); }
      finally { fs.link = originalLink; }
    });
    if (process.platform === 'win32') await test('Windows FAT/exFAT EISDIR falls back to copying without replacing other files', async () => {
      const originalLink = fs.link;
      const unsupported = () => Object.assign(new Error('EISDIR: illegal operation on a directory, link'), { code: 'EISDIR' });
      const failed = path.join(drive, 'POPS', 'WindowsFailed.VCD');
      const raced = path.join(drive, 'POPS', 'WindowsRace.VCD');
      const sourceBefore = await fs.readFile(single);
      fs.link = async () => { throw unsupported(); };
      try {
        const result = await importDisc(single, drive, 'WindowsFat');
        assert.equal(result.success, true, result.message);
        assert.deepEqual(await fs.readFile(result.vcdPath), sourceBefore);
        await validateVcd(result.vcdPath); await noTemps(drive);
        await assert.rejects(publishFile(single, result.vcdPath, validateVcd), /already exists/);
        await assert.rejects(publishFile(single, failed, async () => { throw new Error('verification interruption'); }), /verification interruption/);
        await absent(failed);
        await assert.rejects(publishFile(source, failed, validateVcd), /EISDIR/);
        await absent(failed);
        fs.link = async (_from, to) => { await fs.writeFile(to, 'another import owns this', { flag: 'wx' }); throw unsupported(); };
        await assert.rejects(publishFile(single, raced, validateVcd), /EEXIST/);
        assert.equal((await fs.readFile(raced)).toString(), 'another import owns this');
        assert.deepEqual(await fs.readFile(single), sourceBefore);
      } finally { fs.link = originalLink; }
    });
    await test('POPStarter/POPSLoader retain layouts and refuse collisions', async () => {
      const pop = await importDisc(cue, drive, 'Legacy', 'popstarter'); assert(pop.success, pop.message);
      assert.match(pop.vcdPath, /HBRW_\d{3}\.\d{2}\.Legacy\.VCD$/);
      const launcher = path.join(drive, 'APPS', 'POPS_Legacy'); assert((await fs.readdir(launcher)).some(n => n.startsWith('XX.') && n.endsWith('.ELF')));
      const before = await fs.readFile(path.join(launcher, 'title.cfg'));
      const again = await importDisc(cue, drive, 'Legacy', 'popstarter'); assert.equal(again.success, false);
      assert.deepEqual(await fs.readFile(path.join(launcher, 'title.cfg')), before);
      const r = await importDisc(cue, drive, 'Ript', 'popsloader'); assert(r.success, r.message);
      assert.equal(path.basename(r.vcdPath), 'Ript.VCD'); await absent(path.join(drive, 'APPS', 'POPS_Ript'));
      assert.equal((await importDisc(cue, drive, 'Ript', 'popsloader')).success, false);
    });
    await test('existing PS2 CD conversion still extracts original 2048-byte sector data', async () => {
      const p = await importPs2CdGame(cue, drive, 'SLUS_123.45', 'PS2 Test', false); assert(p.success, p.message);
      const expected = Buffer.concat(Array.from({ length: 8 }, (_, i) => raw(8).subarray(i * sectorSize + 24, i * sectorSize + 24 + 2048)));
      assert.deepEqual(await fs.readFile(p.isoPath), expected);
      const cooked = await file(source, 'PS2.bin', Buffer.alloc(4096, 0x26));
      const c = await file(source, 'PS2.cue', 'FILE "PS2.bin" BINARY\n TRACK 01 MODE1/2048\n INDEX 01 00:00:00');
      const r = await importPs2CdGame(c, drive, 'SLUS_123.46', 'PS2 Cooked', false); assert(r.success, r.message);
      assert.deepEqual(await fs.readFile(r.isoPath), await fs.readFile(cooked));
    });
    await test('settings retain PSXCore selection without changing other preferences', async () => {
      const previous = getSettings(); setSetting('ps1LauncherMode', 'psxcore');
      assert.equal(getSettings().ps1LauncherMode, 'psxcore'); assert.equal(getSettings().theme, previous.theme);
    });
    await test('LUNA artwork uses serial convention and preserves existing art', async () => {
      const r = await importPs1Game(cue, drive, 'XX.', true, 'SLUS_123.45', 'Serial', 'psxcore'); assert(r.success, r.message);
      const args = artworkCalls.at(-1); assert.equal(args[3], 'SLUS_123.45'); assert.deepEqual(args[4], ['COV', 'PSBBN']); assert.equal(args[5], true);
    });
    await test('PSXCore status checks drive firmware and ignores legacy memory-card bootstrap settings', async () => {
      const before = (await fs.readdir(path.join(drive, 'POPS'))).sort();
      const r = await getPsxcoreStatus(drive); assert.equal(r.readyToLaunch, false); assert.equal(r.pops.valid, false);
      assert.deepEqual((await fs.readdir(path.join(drive, 'POPS'))).sort(), before);
      const p = await file(source, 'Wrong.ELF', Buffer.alloc(52));
      assert.equal((await verifyPsxcoreFile(p, { bytes: 52, sha256: '0'.repeat(64) }, true)).valid, false);
      const fingerprint = await file(source, 'Old.json', 'invalid legacy fingerprint');
      const legacy = await getPsxcoreStatus(drive, { revisionFile: fingerprint, bootstrap: path.join(source, 'MissingBootstrap.ELF') });
      assert.deepEqual(legacy, r);
      assert.equal('bootstrap' in legacy, false);
      assert.equal('revision' in legacy, false);
      assert.match(legacy.message, /PS2 memory card/);
    });
    await test('PSXCore game deletion leaves pre-existing saves/cards/runtime byte-for-byte intact', async () => {
      const sentinels = ['ps1emu/card0', 'ps1emu/card1', 'CARDS/Shared.vmc', 'SAVES/old/card0', 'POPS.ELF', 'IOPRP252.IMG'];
      for (const name of sentinels) { const p = path.join(drive, 'POPS', name); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, Buffer.from('existing: ' + name)); }
      const r = await importDisc(cue, drive, 'Delete Me'); assert(r.success, r.message);
      const deleted = await deleteGameAndRelatedFiles(r.vcdPath, path.join(drive, 'ART'), '', undefined); assert(deleted.success);
      for (const name of sentinels) assert.equal((await fs.readFile(path.join(drive, 'POPS', name))).toString(), 'existing: ' + name);
    });
    await test('upstream artwork normalization leaves PS1 card folders and bytes untouched', async () => {
      const normalization = path.join(root, 'normalization'), artDir = path.join(normalization, 'ART');
      await fs.mkdir(artDir, { recursive: true });
      const vcd = await file(normalization, 'Old (Disc 2).VCD', await fs.readFile(single));
      const cards = path.join(normalization, 'Old (Disc 2)'); await fs.mkdir(cards);
      const card = await file(cards, 'card0', Buffer.from('existing save sentinel'));
      await file(artDir, 'Old (Disc 2)_COV.png', Buffer.from('art sentinel'));
      const r = await normalizeRiptOplPs1Storage({ kind: 'VCD', sourcePath: vcd, gameId: 'SCUS_944.02', canonicalTitle: 'Canonical', artDir });
      assert(r.success, r.message); await validateVcd(r.newPath);
      assert.equal((await fs.readFile(card)).toString(), 'existing save sentinel');
      assert.deepEqual(await fs.readdir(cards), ['card0']); await absent(path.join(normalization, 'Canonical'));
      assert.equal((await fs.readFile(path.join(artDir, 'Canonical_COV.png'))).toString(), 'art sentinel');
    });
    console.log(`PS1 preparation: ${checks} checks passed; ${nativeChecks} native PSXCore validator comparisons.`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
