/**
 * Static ratchet (decision 18): this out-of-process connector may consume ONLY
 * the public `@s360/contracts/app-platform` subpath. It must never import an
 * internal Simply360 package, a non-public contracts subpath, the database, the
 * amplify backend, or reach into the monorepo via relative paths.
 *
 * The test greps this project's own `src/` for import/require specifiers and
 * fails on anything outside the allowlist.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

const ALLOWED_S360_SPECIFIER = '@s360/contracts/app-platform';

/** Import specifiers that are always permitted (node builtins, self, deps). */
const isAllowed = (specifier: string): boolean => {
  if (specifier.startsWith('@s360/') || specifier.startsWith('@simply360/')) {
    return specifier === ALLOWED_S360_SPECIFIER;
  }
  // Relative imports must stay inside this project (no monorepo escape).
  if (specifier.startsWith('.')) {
    return !specifier.includes('../../') && !specifier.replace(/^\.\//, '').startsWith('..');
  }
  // node: builtins, aws-lambda types, aws-sdk, zod, etc. are fine.
  return true;
};

const FORBIDDEN_SUBSTRINGS = [
  '@s360/db',
  '@s360/api',
  '@s360/amplify',
  'packages/',
  'amplify/',
  '/backend/',
  'zod/v4', // internal contracts detail; the connector uses the public boundary only
];

const collectFiles = (dir: string): string[] => {
  const entries = readdirSync(dir);
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
};

const SPECIFIER_RE = /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

describe('no-internal-imports ratchet', () => {
  const files = collectFiles(SRC_DIR);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('imports only the public @s360/contracts/app-platform subpath and safe deps', () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(SPECIFIER_RE)) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (!specifier) continue;
        if (!isAllowed(specifier)) violations.push(`${file}: forbidden import "${specifier}"`);
        if (FORBIDDEN_SUBSTRINGS.some((bad) => specifier.includes(bad))) {
          violations.push(`${file}: forbidden substring in "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('uses the public boundary at least once (sanity)', () => {
    const usesPublic = files.some((file) => readFileSync(file, 'utf8').includes(ALLOWED_S360_SPECIFIER));
    expect(usesPublic).toBe(true);
  });
});
