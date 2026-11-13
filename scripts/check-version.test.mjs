import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, 'check-version.mjs');

function run(refName, version) {
  const dir = mkdtempSync(join(tmpdir(), 'fmp-check-version-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
    const env = { ...process.env };
    delete env.GITHUB_REF_NAME;
    if (refName !== undefined) env.GITHUB_REF_NAME = refName;
    return spawnSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('passes when the tag is v + package.json version', () => {
  const result = run('v0.1.0', '0.1.0');
  assert.equal(result.status, 0);
});

test('exits 1 on a version mismatch and names both values', () => {
  const result = run('v0.2.0', '0.1.0');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /v0\.2\.0/);
  assert.match(result.stderr, /v0\.1\.0/);
});

test('exits 1 when the tag lacks the v prefix', () => {
  assert.equal(run('0.1.0', '0.1.0').status, 1);
});

test('exits 1 when GITHUB_REF_NAME is not set', () => {
  assert.equal(run(undefined, '0.1.0').status, 1);
});
