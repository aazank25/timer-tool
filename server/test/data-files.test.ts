import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it, mock } from 'node:test';
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

/**
 * Setting the modes is a safeguard, and a folder can be one this account may write in and not
 * chmod: another account's, with the mode left open (EPERM), or a mount that has no modes at all,
 * FAT or exFAT or a share (EPERM or ENOTSUP), or one that is read-only (EROFS), or one that will
 * not be searched by chmod (EACCES). The data can live there, as it could before the modes were
 * set, so that is said once and gone on from. Anything else that goes wrong still stops the start.
 */
describe('a data folder that will not take a mode', { skip }, () => {
  /** What chmod comes back with when it is refused, as Node writes it. */
  const refusal = (code: string, target: unknown) =>
    Object.assign(new Error(`${code}: operation refused, chmod '${String(target)}'`), {
      code,
      syscall: 'chmod',
      path: String(target),
    });

  /** Runs `body` with every chmod refused for `code`, and gives back what was warned meanwhile. */
  async function refusing<T>(code: string, body: () => T | Promise<T>) {
    const warnings: string[] = [];
    const chmod = mock.method(fs, 'chmodSync', (target: unknown) => {
      throw refusal(code, target);
    });
    const warn = mock.method(console, 'warn', (...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
    try {
      return { result: await body(), warnings };
    } finally {
      chmod.mock.restore();
      warn.mock.restore();
    }
  }

  /** A folder of its own for each case, since a folder is warned about once. */
  const folder = (name: string) => path.join(root, 'refused', name);

  it('is used all the same, and says so once, for every way a mode can be refused', async () => {
    const { ensureDataDir, keepDatabaseToOwner } = await import('../src/lib/config.js');
    for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EROFS', 'EACCES']) {
      const dir = folder(code);
      const file = path.join(dir, 'focusdesk.sqlite');
      const { result, warnings } = await refusing(code, () => {
        const made = ensureDataDir(dir);
        // The database, and what is beside it, takes the same refusals as the folder did.
        fs.writeFileSync(`${file}-wal`, '');
        keepDatabaseToOwner(file);
        return made;
      });
      assert.equal(result, dir, code);
      assert.ok(fs.existsSync(file), `${code}: the database is made all the same`);
      // One warning for the folder, not one for each of the five things it was tried on.
      assert.equal(warnings.length, 1, `${code}: ${warnings.join(' | ')}`);
      const [warning = ''] = warnings;
      assert.match(warning, /^\[focusdesk\] could not keep /, code);
      assert.ok(warning.includes(dir), `${code}: it says which folder`);
      assert.ok(warning.includes(code), `${code}: it says why`);
      // Nothing of what is in the folder: not a file's name.
      assert.ok(!warning.includes('focusdesk.sqlite'), `${code}: ${warning}`);
      assert.ok(!warning.includes('-wal'), `${code}: ${warning}`);
    }
  });

  it('is said again for another folder, and not again for the same one', async () => {
    const { ensureDataDir, keepToOwner } = await import('../src/lib/config.js');
    const first = folder('first-of-two');
    const second = folder('second-of-two');
    const { warnings } = await refusing('EPERM', () => {
      ensureDataDir(first);
      ensureDataDir(first);
      fs.writeFileSync(path.join(first, 'a.sqlite'), '');
      keepToOwner(path.join(first, 'a.sqlite'));
      ensureDataDir(second);
    });
    assert.equal(warnings.length, 2, warnings.join(' | '));
    assert.ok(warnings[0]?.includes(first));
    assert.ok(warnings[1]?.includes(second));
  });

  it('stops the start for any other reason a mode cannot be set', async () => {
    const { ensureDataDir, keepToOwner } = await import('../src/lib/config.js');
    for (const code of ['EIO', 'EINVAL', 'ENOSPC', 'ENOSYS', 'EBADF', 'ELOOP']) {
      const dir = folder(`other-${code}`);
      const file = path.join(dir, 'focusdesk.sqlite');
      const { warnings } = await refusing(code, () => {
        assert.throws(() => ensureDataDir(dir), { code }, `${code} on a folder`);
        fs.writeFileSync(file, '');
        assert.throws(() => keepToOwner(file), { code }, `${code} on a file`);
      });
      assert.deepEqual(warnings, [], code);
    }
  });

  it('still takes a file that is not there to be nothing to do, whatever chmod says of it', async () => {
    const { keepToOwner } = await import('../src/lib/config.js');
    const { warnings } = await refusing('ENOENT', () => {
      keepToOwner(path.join(folder('absent'), 'focusdesk.sqlite'));
    });
    assert.deepEqual(warnings, []);
  });

  it('does not take a refusal to make or open something for one to set a mode', async () => {
    // EACCES is let go of for a mode, and only there: a folder that cannot be made, or a database
    // that cannot be created, is a start that cannot go on.
    const { ensureDataDir, keepDatabaseToOwner } = await import('../src/lib/config.js');
    const denied = (what: string) =>
      Object.assign(new Error(`EACCES: permission denied, ${what}`), { code: 'EACCES' });

    const mkdir = mock.method(fs, 'mkdirSync', () => {
      throw denied('mkdir');
    });
    try {
      assert.throws(() => ensureDataDir(folder('cannot-be-made')), { code: 'EACCES' });
    } finally {
      mkdir.mock.restore();
    }

    const dir = ensureDataDir(folder('cannot-be-opened'));
    const open = mock.method(fs, 'openSync', () => {
      throw denied('open');
    });
    try {
      assert.throws(() => keepDatabaseToOwner(path.join(dir, 'focusdesk.sqlite')), {
        code: 'EACCES',
      });
    } finally {
      open.mock.restore();
    }
  });

  it('starts the server all the same, with one warning, when no mode can be set at all', () => {
    // The whole start as `npm start` makes it, in a process of its own: every chmod is refused, as
    // it is for a folder another account owns, and the database is made and migrated all the same.
    const dir = folder('whole-start');
    const env: NodeJS.ProcessEnv = { ...process.env, FOCUSDESK_DATA_DIR: dir };
    // Not a test of the test runner's, whatever it is run by.
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import fs from 'node:fs';
         fs.chmodSync = (target) => {
           throw Object.assign(new Error('EPERM: operation not permitted, chmod'), { code: 'EPERM' });
         };
         const { initDb, db } = await import('./src/db.ts');
         initDb();
         console.log('tables', db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n);`,
      ],
      {
        cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
        env,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /tables \d+/);
    assert.ok(fs.existsSync(path.join(dir, 'focusdesk.sqlite')));
    const warnings = run.stderr.split('\n').filter((line) => line.includes('[focusdesk]'));
    assert.equal(warnings.length, 1, run.stderr);
    assert.ok(warnings[0]?.includes(dir), warnings[0]);
  });
});
