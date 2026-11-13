import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, 'changelog-section.mjs');

const FIXTURE = `# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.2.0] - 2026-12-01

### Added

- Second release feature.

## [0.1.0] - 2026-11-13

### Added

- Password lock for chosen sites.
- Auto-lock when idle.

### Security

- PBKDF2-SHA256 password hashing.

## [0.0.9] - 2026-11-01

- Old entry.

[Unreleased]: https://example.invalid/compare/v0.2.0...HEAD
[0.1.0]: https://example.invalid/releases/tag/v0.1.0
`;

function run(args, changelogText = FIXTURE) {
  const dir = mkdtempSync(join(tmpdir(), 'fmp-changelog-'));
  try {
    writeFileSync(join(dir, 'CHANGELOG.md'), changelogText);
    const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
    const notesPath = join(dir, 'notes.md');
    const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : null;
    return { ...result, notes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('extracts the 0.1.0 section into notes.md without heading, neighbours or link references', () => {
  const result = run(['0.1.0']);
  assert.equal(result.status, 0);
  assert.ok(result.notes.includes('### Added'));
  assert.ok(result.notes.includes('- Password lock for chosen sites.'));
  assert.ok(result.notes.includes('- PBKDF2-SHA256 password hashing.'));
  assert.ok(!result.notes.includes('## [0.1.0]'));
  assert.ok(!result.notes.includes('Second release feature'));
  assert.ok(!result.notes.includes('Old entry'));
  assert.ok(!result.notes.includes('example.invalid'));
  assert.ok(result.notes.endsWith('\n'));
});

test('exits 1 and writes no notes when the version section is missing', () => {
  const result = run(['9.9.9']);
  assert.equal(result.status, 1);
  assert.equal(result.notes, null);
  assert.match(result.stderr, /9\.9\.9/);
});

test('does not match a version that only shares a prefix', () => {
  const result = run(['0.1'], FIXTURE);
  assert.equal(result.status, 1);
});

test('exits 1 when the section is empty', () => {
  const result = run(['0.1.0'], '# Changelog\n\n## [0.1.0] - 2026-11-13\n\n## [0.0.9] - 2026-11-01\n\n- x\n');
  assert.equal(result.status, 1);
});

test('exits 1 without a version argument', () => {
  assert.equal(run([]).status, 1);
});

test('accepts a heading without a date and a custom output path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmp-changelog-'));
  try {
    writeFileSync(join(dir, 'CHANGELOG.md'), '## [1.0.0]\n\n- Only entry.\n');
    const result = spawnSync(process.execPath, [script, '1.0.0', 'CHANGELOG.md', 'out.md'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(join(dir, 'out.md'), 'utf8'), '- Only entry.\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
