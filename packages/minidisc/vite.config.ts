/**
 * Dev server for the package's own pages (`npm run minidisc:preview`): `dev/preview.html` (every shell preset
 * side by side, spinning; a sample in its sleeve; the spin-loop renderer) and `dev/make-art.html` (the samples'
 * placeholder art). Both can POST files back through `/__save` into `samples/` or `shots/` (dev only).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const PKG = __dirname;
const ROOT = resolve(PKG, '../..');

function saveEndpoint(): Plugin {
  return {
    name: 'minidisc-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end('POST only');
        }
        const target = normalize(new URL(req.url ?? '/', 'http://localhost').searchParams.get('path') ?? '');
        if (!/^(samples|shots)\/[A-Za-z0-9._\-/]+$/.test(target) || target.includes('..')) {
          res.statusCode = 400;
          return res.end('path must be under samples/ or shots/');
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const file = resolve(PKG, target);
          if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, Buffer.concat(chunks));
          res.setHeader('Content-Type', 'text/plain');
          res.end(`saved ${target} (${Buffer.concat(chunks).length} bytes)`);
        });
      });
    },
  };
}

export default defineConfig({
  root: resolve(PKG, 'dev'),
  base: './',
  publicDir: false,
  envDir: PKG,
  plugins: [saveEndpoint()],
  server: {
    port: 5178,
    fs: { allow: [ROOT] },
  },
});
