// LYNK TV: builds the Netlify site into dist/netlify (PWA + /api function).
// Run after `pnpm nx build web --configuration=pwa`.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const out = 'dist/netlify';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/functions`, { recursive: true });
cpSync('dist/apps/web', `${out}/public`, { recursive: true });
writeFileSync(
    `${out}/public/assets/app-config.js`,
    "window.__IPTVNATOR_CONFIG__ = Object.assign({}, window.__IPTVNATOR_CONFIG__, { BACKEND_URL: '/api' });\n"
);

await build({
    entryPoints: ['apps/web-backend/src/netlify.ts'],
    outfile: `${out}/functions/api.js`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    tsconfig: 'apps/web-backend/tsconfig.app.json',
    // Server storage is off on Netlify; keep the native module out of the bundle.
    plugins: [
        {
            name: 'stub-native',
            setup(b) {
                b.onResolve({ filter: /^better-sqlite3$/ }, () => ({
                    path: 'better-sqlite3',
                    namespace: 'stub',
                }));
                b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                    contents:
                        'module.exports = function () { throw new Error("Server storage is not available on this host."); };',
                }));
            },
        },
    ],
    logLevel: 'warning',
});

writeFileSync(
    `${out}/netlify.toml`,
    `[build]
  publish = "public"
  functions = "functions"

[functions]
  node_bundler = "none"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/api/:splat"
  status = 200
  force = true

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

[[headers]]
  for = "/assets/app-config.js"
  [headers.values]
    Cache-Control = "no-store"
`
);
console.log('Netlify site ready in', out);
