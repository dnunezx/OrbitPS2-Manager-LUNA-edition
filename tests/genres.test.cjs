const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeGenre } = require('../dist/src/utils/genre');
const { writeGameCfg, readGameCfg } = require('../dist/src/services/cfg.service');
const { fillGameGenres, assignGameGenres, readGameGenres, setGameGenre, downloadGenre } = require('../dist/src/services/genres.service');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luna-genre-test-'));
  try {
    for (const [input, expected] of [
      [undefined, 'Uncategorized'], ['', 'Uncategorized'], [' Role-playing games ', 'RPG'],
      ['ACTION / Adventure', 'Action'], ['survival_horror', 'Horror'], ['driving', 'Racing'],
      ['Homebrew', 'Homebrew'], ['n/a', 'Uncategorized'], ['x'.repeat(48), 'Uncategorized'], ['é', 'Uncategorized'],
    ]) assert.equal(normalizeGenre(input), expected);
    const id = 'SLUS_203.12', other = 'SCUS_973.99';
    const original = { '$Compatibility': '32', '$VMC_0': 'ExistingCard', Custom: 'Keep me' };
    assert.equal((await writeGameCfg(root, id, original)).success, true);
    const results = await fillGameGenres(root, [id, id], 'PS2', async () => 'Role playing games');
    assert.equal(results.length, 1); assert.equal(results[0].genre, 'RPG'); assert.equal(results[0].changed, true);
    assert.deepEqual((await readGameCfg(root, id)).entries, { ...original, Genre: 'RPG' });
    const preserve = await fillGameGenres(root, [id], 'PS2', async () => { throw Error('Must not fetch assigned genre'); });
    assert.equal(preserve[0].success, true); assert.equal(preserve[0].changed, false);
    const assigned = await assignGameGenres(root, [id, other], 'driving');
    assert(assigned.every(result => result.success && result.genre === 'Racing'));
    const read = await readGameGenres(root, [id.toLowerCase(), other, '../../escape']);
    assert.equal(read[0].genre, 'Racing'); assert.equal(read[2].success, false);
    assert.equal((await readGameCfg(root, id)).entries.Custom, 'Keep me');
    await setGameGenre(root, id, '');
    const noAuto = await fillGameGenres(root, [id], 'PS2', async () => { throw Error('Explicit Uncategorized must stay'); });
    assert.equal(noAuto[0].success, true); assert.equal(noAuto[0].genre, 'Uncategorized');
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const concurrent = fillGameGenres(root, ['SLUS_000.01'], 'PS2', async () => { await waiting; return 'Action'; });
    await setGameGenre(root, 'SLUS_000.01', 'Puzzle'); release();
    assert.equal((await concurrent)[0].genre, 'Puzzle');
    const failure = await fillGameGenres(root, ['SLUS_000.02'], 'PS2', async () => { throw Error('offline'); });
    assert.equal(failure[0].success, false);
    assert.deepEqual((await readGameCfg(root, 'SLUS_000.02')).entries, {});
    assert(!((await fs.readdir(path.join(root, 'CFG'))).some(name => name.endsWith('.tmp'))));
    if (process.argv.includes('--live')) {
      assert.equal(normalizeGenre(await downloadGenre(id)), 'RPG');
      assert.equal(await downloadGenre('ZZZZ_999.99'), 'Uncategorized');
      console.log('Public catalog lookup: passed');
    }
    console.log('Loader genre assignment, preservation, concurrency, and offline tests passed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
