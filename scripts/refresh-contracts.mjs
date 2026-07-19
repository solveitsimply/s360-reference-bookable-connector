// Refresh the vendored @s360/contracts tarball from a local monorepo checkout.
//
// npm publication of @s360/contracts is DEFERRED (pause point recorded in the
// program plan). Until then this connector consumes the contracts package as a
// committed tarball under vendor/. This script re-packs it from a local
// simply360 checkout:
//
//   S360_MONOREPO_PATH=/path/to/simply360 node scripts/refresh-contracts.mjs
//
// It runs `npm run build` + `npm pack` in packages/contracts and copies the
// resulting tarball into vendor/, then reminds you to bump the file: dependency
// in package.json if the version changed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const monorepo = process.env.S360_MONOREPO_PATH;
if (!monorepo) {
  console.error('Set S360_MONOREPO_PATH to your local simply360 checkout.');
  process.exit(1);
}

const contractsDir = join(monorepo, 'packages', 'contracts');
const vendorDir = join(root, 'vendor');

console.log(`Building @s360/contracts in ${contractsDir} ...`);
execFileSync('npm', ['run', 'build'], { cwd: contractsDir, stdio: 'inherit' });

console.log('Packing tarball ...');
execFileSync('npm', ['pack', '--pack-destination', vendorDir], { cwd: contractsDir, stdio: 'inherit' });

const pkg = JSON.parse(readFileSync(join(contractsDir, 'package.json'), 'utf8'));
const expected = `s360-contracts-${pkg.version}.tgz`;
const packed = readdirSync(vendorDir).filter((f) => f.endsWith('.tgz'));
console.log(`Vendored: ${packed.join(', ')}`);
console.log(`Ensure package.json "@s360/contracts" points to vendor/${expected}`);

// Keep only the newest tarball name deterministic for the git commit.
if (packed.includes(expected)) {
  copyFileSync(join(vendorDir, expected), join(vendorDir, expected));
}
