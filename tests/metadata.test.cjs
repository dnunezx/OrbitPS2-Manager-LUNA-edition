const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { parseGameCfg, readGameCfg, writeGameCfg, patchGameCfg } = require('../dist/src/services/cfg.service');
const { downloadGameMetadata, lookupGameMetadata, metadataFromCfg, fillGameMetadata } = require('../dist/src/services/game-metadata.service');

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luna-metadata-test-'));
  const originalGet = https.get;
  try {
    const id = 'SLUS_203.12';
    const original = { '#Name': 'Local title', '$Compatibility': '32', '$DMA': '7', '$VMC_0': 'Card', Custom: 'Keep=a=b', Genre: 'Puzzle', Players: 'players/2' };
    assert.deepEqual(parseGameCfg('\uFEFFDeveloper=Studio\r\nDescription=Text=with=equals\n'), { Developer: 'Studio', Description: 'Text=with=equals' });
    assert.deepEqual(metadataFromCfg({ ...original, Release: '05-17-2002', '#Developer': 'Studio' }), { Genre: 'Puzzle', Players: 'players/2', Release: '05-17-2002', Developer: 'Studio' });
    assert.equal((await writeGameCfg(root, id, original)).success, true);
    assert.equal((await writeGameCfg(root, id, { Description: 'bad\n$DMA=0' })).success, false);
    assert.deepEqual((await readGameCfg(root, id)).entries, original);
    assert.equal((await readGameCfg(root, '../../escape')).success, false);
    assert.equal((await readGameCfg(root, `${id}.cfg.bak`)).success, false);

    let requests = 0, mode = 'ok';
    https.get = (url, callback) => {
      requests++;
      assert(url.startsWith('https://raw.githubusercontent.com/t0mg/PS2-OPL-CFG-Database/master/CFG/'));
      const request = new EventEmitter();
      request.setTimeout = () => {};
      queueMicrotask(() => {
        if (mode === 'error') { request.emit('error', new Error('offline')); return; }
        const response = new EventEmitter();
        response.statusCode = mode === 'missing' ? 404 : 200;
        response.resume = () => {};
        callback(response);
        if (response.statusCode === 200) {
          response.emit('data', Buffer.from('Release=05-17-2002\nDeveloper=Remote studio\nDescription=Story=with equals\nGenre=Role playing games\nPlayers=players/4\nPlayersText=1-4\n$Compatibility=255\n$VMC_0=Remote card\n'));
          response.emit('end');
        }
      });
      return request;
    };
    const remote = await downloadGameMetadata(id.toLowerCase());
    assert.equal(remote.Release, '05-17-2002');
    assert.equal(remote.PlayersText, '1-4');
    assert(!('$Compatibility' in remote)); assert(!('$VMC_0' in remote));
    remote.Developer = 'Mutation';
    assert.equal((await downloadGameMetadata(id)).Developer, 'Remote studio');
    assert.equal(requests, 1);
    mode = 'missing'; assert.deepEqual(await downloadGameMetadata('ZZZZ_999.99'), {});
    mode = 'error'; assert.equal((await lookupGameMetadata('SLUS_000.01')).success, false);
    mode = 'ok'; assert.equal((await lookupGameMetadata('SLUS_000.01')).success, true);

    let saved = 0, closed = 0;
    const logger = { log() {}, error() {} };
    const cfgService = new cfgRenderer.CfgService({ currentDirectoryValue: root }, logger);
    global.window = { libraryAPI: {
      readGameCfg, patchGameCfg: async (...args) => { saved++; return patchGameCfg(...args); },
      lookupGameMetadata,
    } };
    const makeEditor = () => {
      const editor = new GameCfgDialogComponent(cfgService, { refresh: async () => [] }, { markForCheck() {} });
      editor.game = () => ({ gameId: id, system: 'PS2', title: 'Game' });
      editor.closed.emit = () => { closed++; };
      return editor;
    };
    const editor = makeEditor(); await editor.ngOnInit();
    assert.equal(editor.metadata.PlayersText, '2');
    editor.metadata.Developer = 'User draft';
    await editor.fillMissingMetadata();
    assert.equal(editor.metadata.Genre, 'Puzzle');
    assert.equal(editor.metadata.Developer, 'User draft');
    assert.equal(saved, 0, 'Lookup must not write to disk');
    assert.deepEqual((await readGameCfg(root, id)).entries, original);
    editor.metadata.PlayersText = '1-4'; editor.metadata.Description = 'Line one\nLine two=story';
    await patchGameCfg(root, id, { BackgroundJob: 'Preserve concurrent update' });
    await editor.save();
    const edited = (await readGameCfg(root, id)).entries;
    assert.equal(edited.Release, '05-17-2002'); assert.equal(edited.Description, 'Line one Line two=story');
    assert.equal(edited.Players, 'players/4'); assert.equal(edited.PlayersText, '1-4');
    assert.equal(edited.BackgroundJob, 'Preserve concurrent update');
    for (const key of ['Genre', 'Custom', '$Compatibility', '$DMA', '$VMC_0']) assert.equal(edited[key], original[key]);
    const body = await fs.readFile(path.join(root, 'CFG', `${id}.cfg`), 'utf8');
    assert(!/(?<!\r)\n/.test(body), 'OPL files use CRLF');

    const clear = makeEditor(); await clear.ngOnInit(); clear.metadata.PlayersText = ''; await clear.save();
    const cleared = (await readGameCfg(root, id)).entries;
    assert(!('Players' in cleared)); assert(!('PlayersText' in cleared));
    const failed = makeEditor(); await failed.ngOnInit();
    window.libraryAPI.patchGameCfg = async () => ({ success: false, message: 'Drive removed' });
    const before = closed; await failed.save(); assert.equal(closed, before); assert(failed.error); assert.equal(failed.saving, false);
    const unreadable = makeEditor(); window.libraryAPI.readGameCfg = async () => ({ success: false, entries: {}, message: 'Read denied' });
    await unreadable.ngOnInit(); assert.equal(unreadable.hasChanges, false); assert.equal(unreadable.error, 'Read denied');

    assert.equal((await patchGameCfg(root, 'SLUS_000.02', { Developer: 'New studio' })).success, true);
    assert.equal((await readGameCfg(root, 'SLUS_000.02')).entries.Developer, 'New studio');
    const autoId = 'SLUS_000.03';
    await writeGameCfg(root, autoId, { ...original, Developer: 'Local studio', Release: '1999' });
    const auto = await fillGameMetadata(root, [autoId, autoId], 'PS2', async () => ({
      Release: '2002', Developer: 'Remote studio', Genre: 'Action', Description: 'x'.repeat(300),
      Players: 'players/4', PlayersText: '1-4', '$DMA': '0', '$Compatibility': '255',
    }));
    assert.equal(auto.length, 1); assert.equal(auto[0].changed, true);
    const autoCfg = (await readGameCfg(root, autoId)).entries;
    assert.equal(autoCfg.Developer, 'Local studio'); assert.equal(autoCfg.Release, '1999');
    assert.equal(autoCfg.Description.length, 255); assert.equal(autoCfg.Players, 'players/2');
    assert(!('PlayersText' in autoCfg), 'Keep the existing player count instead of importing a conflicting display count');
    for (const key of ['Genre', 'Custom', '$Compatibility', '$DMA', '$VMC_0']) assert.equal(autoCfg[key], original[key]);
    const full = await fillGameMetadata(root, [autoId], 'PS2', async () => { throw Error('Complete metadata must not fetch'); });
    assert.equal(full[0].success, true); assert.equal(full[0].changed, false);
    const missingId = 'SLUS_000.04';
    assert.equal((await fillGameMetadata(root, [missingId], 'PS2', async () => ({})))[0].changed, false);
    assert.equal((await fillGameMetadata(root, [missingId], 'PS1', async () => { throw Error('PS1 must not fetch PS2 metadata'); }))[0].success, true);
    assert.equal((await fillGameMetadata(root, [missingId], 'PS2', async () => { throw Error('offline'); }))[0].success, false);
    assert.deepEqual((await readGameCfg(root, missingId)).entries, {});
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const concurrent = fillGameMetadata(root, [missingId], 'PS2', async () => { await waiting; return { Developer: 'Remote', Description: 'New story' }; });
    await patchGameCfg(root, missingId, { Developer: 'Concurrent edit' }); release();
    await concurrent;
    assert.equal((await readGameCfg(root, missingId)).entries.Developer, 'Concurrent edit');
    assert.equal((await readGameCfg(root, missingId)).entries.Description, 'New story');

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
    const artwork = await downloadArtByGameId(path.join(root, 'ART'), id, 'PS2');
    assert(artwork.data.some(item => item.type === 'LGO'));
    assert.equal((await readGameCfg(root, id)).entries.PlayersText, '1-4', 'Metadata is filled even when artwork is unavailable');
    console.log('Metadata lookup, editor staging, create/edit, preservation, players, and failure tests passed');
  } finally {
    https.get = originalGet;
    delete global.window;
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
