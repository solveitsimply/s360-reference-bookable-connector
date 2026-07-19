// Bundle the Lambda handler into a single ESM file with esbuild.
// @aws-sdk/* is provided by the Lambda Node.js runtime, so it stays external.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [`${root}src/handler.ts`],
  outfile: `${root}dist/handler.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  external: ['@aws-sdk/*'],
  banner: {
    // Some transitive CJS deps expect `require`/`__dirname` under ESM.
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

console.log('Bundled dist/handler.mjs');
