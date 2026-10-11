const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const rxjs = require('../angular/node_modules/rxjs');
function load(file, deps) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => {
    assert(name in deps, `Unexpected dependency ${name}`); return deps[name];
  }, exports);
  return exports;
}
const core = { Component: () => t => t, Injectable: () => t => t };
const { ImportComponent } = load('angular/src/app/pages/import/import.component.ts', {
  '@angular/core': core, 'lucide-angular': {}, '@angular/common': {},
  '../../shared/services/library.service': {}, '../../shared/services/jobs.service': {}, '../../shared/services/settings.service': {},
});
const { JobsService } = load('angular/src/app/shared/services/jobs.service.ts', {
  '@angular/core': core, rxjs,
  './logs.service': {}, './library.service': {}, './confirm-dialog.service': {},
});
const { LibraryService } = load('angular/src/app/shared/services/library.service.ts', {
  '@angular/core': core, rxjs, './logs.service': {}, './settings.service': {}, '../types/game.type': {},
});

(async () => {
  let queued, persisted, ipcCall, progressRemoved = false;
  global.window = { libraryAPI: {
    openAskGameFiles: async () => ({ canceled: false, filePaths: ['TwoDiscs.zip'] }),
    inspectPs1Source: async () => ({ success: true, path: 'TwoDiscs.zip', discs: ['Disc 1/Game.cue', 'Disc 2/Game.cue'] }),
    getPsxcoreStatus: async () => ({ success: true, readyToLaunch: false, message: 'console integration pending' }),
    importPs1Game: async (...args) => { ipcCall = args; return { success: true }; },
    onPs1ImportProgress: () => {}, removeAllPs1ImportProgressListeners: () => { progressRemoved = true; },
    tryDeterminePs1GameIdFromVcd: async () => ({ success: false }),
    validatePs1Vcd: async () => ({ success: true }),
  } };
  const c = new ImportComponent({ currentDirectoryValue: 'X:\\' }, { enqueue: jobs => queued = jobs }, {
    load: async () => ({ ps1LauncherMode: 'psxcore' }), set: async (...args) => persisted = args,
  });
  await c.ngOnInit(); assert.equal(c.launcherMode, 'psxcore'); assert.equal(c.psxcoreStatus.readyToLaunch, false);
  c.setLauncherMode('psxcore'); assert.deepEqual(persisted, ['ps1LauncherMode', 'psxcore']);
  c.setMode('ps1'); await c.addFiles(); assert.equal(c.staged.length, 2); assert.equal(c.readyCount, 0);
  c.staged[1].selected = true; assert.equal(c.readyCount, 1); c.importAll();
  assert.equal(queued.length, 1); assert.equal(queued[0].archiveEntry, 'Disc 2/Game.cue'); assert.equal(queued[0].launcherMode, 'psxcore');
  const jobs = Object.create(JobsService.prototype); jobs.patchJob = () => {};
  await jobs.runPs1Job({ ...queued[0], id: 'test' }, 'X:\\');
  assert.equal(ipcCall[6], 'psxcore'); assert.equal(ipcCall[7], 'Disc 2/Game.cue'); assert.equal(progressRemoved, true);
  c.setMode('ps2-cd'); c.staged = [{ key: 'manual.cue', path: 'manual.cue', selected: true, invalid: true, gameName: 'Manual PS2', gameId: 'SLUS_123.45' }];
  assert.equal(c.readyCount, 1); c.importAll(); assert.equal(queued[0].launcherMode, undefined);
  c.setMode('ps2-dvd'); c.keepOriginalName = true;
  c.staged = [{ key: 'DVD.iso', path: 'DVD.iso', selected: true, invalid: false, gameName: 'PS2 DVD', gameId: 'SLUS_123.45' }];
  c.importAll(); assert.equal(queued[0].type, 'ps2-dvd'); assert.equal(queued[0].keepOriginalName, true);
  const library = Object.create(LibraryService.prototype); library.setCurrentAction = () => {};
  const game = await library.parseSingleFile({ name: 'Homebrew (Disc 2)', extension: '.VCD', path: 'X:\\POPS\\Homebrew (Disc 2).VCD', parentPath: 'X:\\POPS', stats: { size: 1234567 } });
  assert.equal(game.system, 'PS1'); assert.equal(game.gameId, ''); assert.equal(game.title, 'Homebrew (Disc 2)');
  window.libraryAPI.validatePs1Vcd = async () => ({ success: false });
  assert.equal(await library.parseSingleFile({ name: 'Invalid', extension: '.VCD', path: 'X:\\POPS\\Invalid.VCD', parentPath: 'X:\\POPS', stats: { size: 1 } }), null);
  const invokes = [];
  let api;
  load('src/preload.ts', { electron: { contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'libraryAPI') api = value; } },
    ipcRenderer: { invoke: (...args) => invokes.push(args) } } });
  api.importPs1Game('archive.zip', 'X:\\', 'XX.', false, undefined, 'Game', 'psxcore', 'Disc 2/Game.cue');
  assert.deepEqual(invokes[0], ['import-ps1-game', 'archive.zip', 'X:\\', 'XX.', false, undefined, 'Game', 'psxcore', 'Disc 2/Game.cue']);
  console.log('PS1 renderer checks passed: persisted mode, explicit disc selection, queue/preload propagation, serial-free PS1 visibility, malformed rejection, PS2 manual import.');
})().catch(error => { console.error(error); process.exitCode = 1; });
