#!/usr/bin/env node
// Release guard: fails unless the pushed tag is "v" + the package.json version.
// package.json is the only version source (WXT copies it into the manifest).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const expected = `v${version}`;
const actual = process.env.GITHUB_REF_NAME;

if (actual !== expected) {
  console.error(
    `Version mismatch: tag is "${actual ?? '(GITHUB_REF_NAME not set)'}" but package.json version gives "${expected}".`,
  );
  process.exit(1);
}

console.log(`Tag ${actual} matches package.json version ${version}.`);
