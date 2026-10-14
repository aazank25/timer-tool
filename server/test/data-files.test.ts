import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * The data folder and every file of the database are their owner's alone, so that no other
 * account on the computer can list the folder or read the files in it (ensureDataDir and
 * keepDatabaseToOwner in lib/config.ts, run by db.ts as it opens the database). Windows has no
 * modes to look at.
 */
const skip = process.platform === 'win32' && 'Windows has no file modes';

// The mask most systems start a process with: a new file is readable by every account, and a new
// folder can be listed by every account. Everything below is made under it, and must not be.
process.umask(0o022);

/**
 * A data folder that is not there yet, two levels down, for db.ts to make when it is first
 * imported, as on the first launch. Set before anything imports config.ts, which reads it once.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focusdesk-modes-'));
const dataDir = path.join(root, 'first', 'data');
process.env.FOCUSDESK_DATA_DIR = dataDir;
process.env.TZ = 'UTC';
after(() => fs.rmSync(root, { recursive: true, force: true }));

const modeOf = (file: string) => fs.statSync(file).mode & 0o777;
const octal = (mode: number) => mode.toString(8);

describe('the data folder and the database', { skip }, () => {
  it('are made for their owner alone on the first launch', async () => {
    const { db, initDb } = await import('../src/db.js');
    initDb();
    const file = path.join(dataDir, 'focusdesk.sqlite');

    assert.equal(octal(modeOf(dataDir)), '700');
    // And the folder made on the way to it.
    assert.equal(octal(modeOf(path.dirname(dataDir))), '700');
    assert.equal(octal(modeOf(file)), '600');
    // SQLite makes these as the database is written, and gives them the database's mode.
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    for (const beside of [`${file}-wal`, `${file}-shm`]) {
      assert.ok(fs.existsSync(beside), `${beside} is there to look at`);
      assert.equal(octal(modeOf(beside)), '600', beside);
    }
  });

  it('keep the copy taken before a migration to its owner', async () => {
    const { db, backupBeforeMigrating } = await import('../src/db.js');
    const backup = backupBeforeMigrating(db, path.join(dataDir, 'focusdesk.sqlite'), 1, 99);
    assert.ok(backup, 'an existing database is backed up');
    assert.equal(path.dirname(backup), dataDir);
    assert.equal(octal(modeOf(backup)), '600');
  });

  it('take an install whose files every account could read back for their owner', () => {
    // A folder and a database as mkdir and SQLite make them under that mask, with what a crash
    // leaves beside it, and a second connection holding the database open as the server starts.
    const earlier = path.join(root, 'earlier');
    fs.mkdirSync(earlier);
    const file = path.join(earlier, 'focusdesk.sqlite');
    const other = new Database(file);
    try {
      other.pragma('journal_mode = WAL');
      other.exec("CREATE TABLE kept (note TEXT); INSERT INTO kept VALUES ('history');");
      const files = [file, `${file}-wal`, `${file}-shm`];
      for (const each of files) fs.chmodSync(each, 0o644);
      assert.equal(octal(modeOf(earlier)), '755', 'the folder starts open to every account');

      // The server, started on it in a process of its own, as `npm start` would be.
      const env: NodeJS.ProcessEnv = { ...process.env, FOCUSDESK_DATA_DIR: earlier };
      // Not a test of the test runner's, whatever it is run by.
      delete env.NODE_TEST_CONTEXT;
      const run = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          "const { initDb } = await import('./src/db.ts'); initDb();",
        ],
        {
          cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
          env,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      assert.equal(run.status, 0, run.stderr);

      assert.equal(octal(modeOf(earlier)), '700');
      for (const each of files) assert.equal(octal(modeOf(each)), '600', each);
      // Nothing of it is lost, and nothing is made beside it that was not there.
      assert.deepEqual(other.prepare('SELECT note FROM kept').all(), [{ note: 'history' }]);
      assert.ok(!fs.existsSync(`${file}-journal`));
    } finally {
      other.close();
    }
  });

  it('are set without opening a file that is there already, and leave one that is not alone', async () => {
    const { ensureDataDir, keepDatabaseToOwner, keepToOwner } = await import(
      '../src/lib/config.js'
    );
    const dir = ensureDataDir(path.join(root, 'loose'));
    assert.equal(octal(modeOf(dir)), '700');

    const file = path.join(dir, 'focusdesk.sqlite');
    fs.writeFileSync(file, 'what was there', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    keepDatabaseToOwner(file);
    assert.equal(octal(modeOf(file)), '600');
    assert.equal(fs.readFileSync(file, 'utf8'), 'what was there');
    for (const missing of ['-wal', '-shm', '-journal']) {
      assert.ok(!fs.existsSync(file + missing), missing);
    }

    // A file that is not there is not made, and is no error.
    keepToOwner(path.join(dir, 'not-there.sqlite'));
    assert.ok(!fs.existsSync(path.join(dir, 'not-there.sqlite')));
  });
});
