import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const envFile = process.argv[2];
assert.ok(envFile, 'Pass the generated test environment file');
const root = fileURLToPath(new URL('../', import.meta.url));

for (const file of ['compose.yaml', 'compose.postgres.yaml']) {
  const rendered = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '-f', file, 'config', '--format', 'json'],
    {
      cwd: root,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    },
  );
  assert.equal(rendered.status, 0, `${file} must render successfully without starting Docker`);
  const config = JSON.parse(rendered.stdout);
  assert.ok(config.services.sync.security_opt.includes('no-new-privileges:true'));
  if (file === 'compose.postgres.yaml') {
    const target = '/var/lib/postgresql/data';
    const storage = config.services.postgres.volumes.find((mount) => mount.target === target);
    assert.ok(storage, 'PostgreSQL must mount its existing data directory');
    assert.equal(storage.type, 'volume', 'A normal upgrade must keep the existing named volume');
    const resolvedVolume = config.volumes[storage.source]?.name;
    assert.equal(
      resolvedVolume,
      'ravelon-sync_postgres_data',
      'The default deployment must reuse the existing PostgreSQL volume',
    );
    console.log(`Validated ${file}: ${resolvedVolume} -> ${target}`);
  } else {
    console.log(`Validated ${file}`);
  }
}
