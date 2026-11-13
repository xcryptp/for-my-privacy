#!/usr/bin/env node
// Extracts one version's section from a Keep a Changelog file for GitHub Release notes.
// Usage: node scripts/changelog-section.mjs <version> [changelog=CHANGELOG.md] [out=notes.md]
// Exits 1 (and writes nothing) when the section is missing or empty.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [version, changelogPath = 'CHANGELOG.md', outPath = 'notes.md'] = process.argv.slice(2);

if (!version) {
  console.error('Usage: node scripts/changelog-section.mjs <version> [changelog] [out]');
  process.exit(1);
}

const lines = readFileSync(join(process.cwd(), changelogPath), 'utf8').split(/\r?\n/);

// Matches "## [0.1.0]" and "## [0.1.0] - 2026-11-13" exactly (no prefix matches).
const isTargetHeading = (line) => {
  const match = /^##\s+\[([^\]]+)\](?:\s|$)/.exec(line);
  return match !== null && match[1] === version;
};
// The section ends at the next "## " heading or at the link reference block ("[x]: url").
const isSectionEnd = (line) => /^##\s/.test(line) || /^\[[^\]]+\]:\s/.test(line);

const start = lines.findIndex(isTargetHeading);
if (start === -1) {
  console.error(`No section for version ${version} in ${changelogPath}.`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (isSectionEnd(lines[i])) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join('\n').trim();
if (body === '') {
  console.error(`The section for version ${version} in ${changelogPath} is empty.`);
  process.exit(1);
}

writeFileSync(join(process.cwd(), outPath), `${body}\n`);
console.log(`Wrote ${outPath} for version ${version}.`);
