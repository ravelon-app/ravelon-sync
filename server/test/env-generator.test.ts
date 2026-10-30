import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const script = fileURLToPath(new URL('../../scripts/generate-env.sh', import.meta.url));
const testSecret = 'disposable-generator-test-key-0123456789';

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ravelon-env-generator-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PUBLIC_URL: 'https://sync.example.test',
    SYNC_JWT_SECRET: testSecret,
    MFA_ENCRYPTION_KEY: `${testSecret}-mfa`,
    SETTINGS_ENCRYPTION_KEY: `${testSecret}-settings`,
  };
  return {
    directory,
    run(values: NodeJS.ProcessEnv = {}, args: string[] = []) {
      return spawnSync('bash', [script, '--yes', ...args], {
        cwd: directory,
        env: { ...env, ...values },
        encoding: 'utf8',
      });
    },
    nextArguments(output: string) {
      const command = /^Next: (.+)$/m.exec(output)?.[1];
      assert.ok(command, 'The generator must provide a command to start the selected deployment');
      const bin = path.join(directory, 'bin');
      mkdirSync(bin);
      const captured = path.join(directory, 'docker-arguments');
      writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$CAPTURE_ARGS"\n', {
        mode: 0o700,
      });
      const result = spawnSync('bash', ['-c', command], {
        cwd: directory,
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, CAPTURE_ARGS: captured },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(captured, 'utf8').split('\0').slice(0, -1);
    },
  };
}

for (const database of ['sqlite', 'postgres', 'external']) {
  test(`the env generator starts the selected ${database} deployment`, (t) => {
    const f = fixture(t);
    const result = f.run({
      DATABASE: database,
      ...(database === 'external'
        ? { DATABASE_URL: 'postgresql://test:disposable@db.internal/ravelon' }
        : {}),
    });
    assert.equal(result.status, 0, result.stderr);
    const config = parseEnv(readFileSync(path.join(f.directory, '.env'), 'utf8'));
    assert.equal(loadConfig({ ...config, NODE_ENV: 'production' }).publicUrl, 'https://sync.example.test');
    assert.deepEqual(
      f.nextArguments(result.stderr),
      database === 'postgres'
        ? ['compose', '-f', 'compose.postgres.yaml', 'up', '-d']
        : ['compose', 'up', '-d'],
    );
    assert.equal(statSync(path.join(f.directory, '.env')).mode & 0o777, 0o600);
    assert.ok(!result.stderr.includes(testSecret));
  });
}

test('the generated start command preserves a custom env path containing spaces', (t) => {
  const f = fixture(t);
  const result = f.run({ DATABASE: 'postgres', ENV_OUTPUT: 'settings with spaces.env' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.nextArguments(result.stderr), [
    'compose',
    '--env-file',
    'settings with spaces.env',
    '-f',
    'compose.postgres.yaml',
    'up',
    '-d',
  ]);
});

test('regenerating an existing env preserves fallback encryption keys and private file modes', (t) => {
  const f = fixture(t);
  const envFile = path.join(f.directory, '.env');
  const source = `PUBLIC_URL=https://sync.example.test\nSYNC_JWT_SECRET=${testSecret}\nCUSTOM_VALUE='literal$(not-executed)'\n`;
  writeFileSync(envFile, source, { mode: 0o600 });
  const result = f.run({ MFA_ENCRYPTION_KEY: undefined, SETTINGS_ENCRYPTION_KEY: undefined }, ['--force']);
  assert.equal(result.status, 0, result.stderr);
  const config = parseEnv(readFileSync(envFile, 'utf8'));
  assert.equal(config.SYNC_JWT_SECRET, testSecret);
  assert.equal(config.MFA_ENCRYPTION_KEY, testSecret);
  assert.equal(config.SETTINGS_ENCRYPTION_KEY, testSecret);
  assert.equal(config.CUSTOM_VALUE, 'literal$(not-executed)');
  assert.equal(readFileSync(`${envFile}.bak`, 'utf8'), source);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.equal(statSync(`${envFile}.bak`).mode & 0o777, 0o600);
  assert.ok(!result.stderr.includes(testSecret));
});

test('missing required values leave an existing env untouched', (t) => {
  const f = fixture(t);
  const envFile = path.join(f.directory, '.env');
  const source = `SYNC_JWT_SECRET=${testSecret}\n`;
  writeFileSync(envFile, source, { mode: 0o600 });
  const result = f.run({ PUBLIC_URL: undefined }, ['--force']);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(envFile, 'utf8'), source);
  assert.equal(existsSync(`${envFile}.bak`), false);
});
