const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { parseGameCfg, readGameCfg, writeGameCfg, patchGameCfg } = require('../dist/src/services/cfg.service');

// Exercise the editor's async behavior without requiring an Electron window.
function loadRenderer(file, dependencies) {
  const ts = require('typescript');
  const code = ts.transpileModule(require('node:fs').readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', code)((name) => {
    assert(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const core = {
  Component: () => (type) => type, Injectable: () => (type) => type,
  input: { required: () => () => null }, output: () => ({ emit() {} }),
  signal: (value) => Object.assign(() => value, { set: (next) => { value = next; } }),
};
const cfgRenderer = loadRenderer('angular/src/app/shared/services/cfg.service.ts', {
  '@angular/core': core, './library.service': {}, './logs.service': {},
});
const { GameCfgDialogComponent } = loadRenderer('angular/src/app/pages/library/components/game-cfg-dialog/game-cfg-dialog.component.ts', {
  '@angular/core': core, 'lucide-angular': {}, '@shared/services/cfg.service': cfgRenderer, '@shared/services/vmc.service': {},
});

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luna-cfg-test-'));
  const originalGet = https.get;
  try {
    const id = 'SLUS_203.12';
    const original = { '#Name': 'Local title', '$Compatibility': '32', '$DMA': '7', '$VMC_0': 'Card', Custom: 'Keep=a=b', Genre: 'Puzzle', Players: 'players/2' };
    assert.deepEqual(parseGameCfg('\uFEFFDeveloper=Studio\r\nDescription=Text=with=equals\n'), { Developer: 'Studio', Description: 'Text=with=equals' });
    assert.equal((await writeGameCfg(root, id, original)).success, true);
    assert.equal((await writeGameCfg(root, id, { Description: 'bad\n$DMA=0' })).success, false);
    assert.deepEqual((await readGameCfg(root, id)).entries, original);
    assert.equal((await readGameCfg(root, '../../escape')).success, false);
    assert.equal((await readGameCfg(root, `${id}.cfg.bak`)).success, false);

    let saved = 0, closed = 0;
    const logger = { log() {}, error() {} };
    const cfgService = new cfgRenderer.CfgService({ currentDirectoryValue: root }, logger);
    global.window = { libraryAPI: {
      readGameCfg, patchGameCfg: async (...args) => { saved++; return patchGameCfg(...args); },
    } };
    const makeEditor = () => {
      const editor = new GameCfgDialogComponent(cfgService, { refresh: async () => [] }, { markForCheck() {} });
      editor.game = () => ({ gameId: id, system: 'PS2', title: 'Game' });
      editor.closed.emit = () => { closed++; };
      return editor;
    };
    const editor = makeEditor(); await editor.ngOnInit();
    await patchGameCfg(root, id, { BackgroundJob: 'Preserve concurrent update' });
    editor.title = 'Updated title';
    await editor.save();
    assert.equal(saved, 1);
    const edited = (await readGameCfg(root, id)).entries;
    assert.equal(edited['#Name'], 'Updated title');
    assert.equal(edited.BackgroundJob, 'Preserve concurrent update');
    for (const key of ['Genre', 'Players', 'Custom', '$Compatibility', '$DMA', '$VMC_0']) assert.equal(edited[key], original[key]);
    const body = await fs.readFile(path.join(root, 'CFG', `${id}.cfg`), 'utf8');
    assert(!/(?<!\r)\n/.test(body), 'OPL files use CRLF');

    const failed = makeEditor(); await failed.ngOnInit();
    window.libraryAPI.patchGameCfg = async () => ({ success: false, message: 'Drive removed' });
    const before = closed; await failed.save(); assert.equal(closed, before); assert(failed.error); assert.equal(failed.saving, false);
    const unreadable = makeEditor(); window.libraryAPI.readGameCfg = async () => ({ success: false, entries: {}, message: 'Read denied' });
    await unreadable.ngOnInit(); assert.equal(unreadable.hasChanges, false); assert.equal(unreadable.error, 'Read denied');

    assert.equal((await patchGameCfg(root, 'SLUS_000.02', { Developer: 'New studio' })).success, true);
    assert.equal((await readGameCfg(root, 'SLUS_000.02')).entries.Developer, 'New studio');
    // Default artwork includes LGO even when catalog images are unavailable.
    https.get = (_url, callback) => {
      const request = new EventEmitter(); request.setTimeout = () => {};
      queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = 404; response.resume = () => {};
        callback(response);
      });
      return request;
    };
    const { downloadArtByGameId } = require('../dist/src/services/artwork.service');
    const beforeArtwork = (await readGameCfg(root, id)).entries;
    const artwork = await downloadArtByGameId(path.join(root, 'ART'), id, 'PS2');
    assert(artwork.data.some(item => item.type === 'LGO'));
    assert.deepEqual((await readGameCfg(root, id)).entries, beforeArtwork, 'Artwork downloads preserve the existing CFG');
    console.log('CFG editing, preservation, concurrent updates, validation, and failure tests passed');
  } finally {
    https.get = originalGet;
    delete global.window;
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
