import { createReadStream, existsSync, statSync } from 'fs';
import { defineConfig, type Plugin } from 'vite';
import { extname, normalize, resolve } from 'path';

/**
 * Dev server only: serves the staged generic release bundle at /release-bundle/ (the admin release portal builds
 * zips from it). `npm run build` puts it in dist/; for `npm run dev`, run `npm run stage:release-bundle` once.
 */
function releaseBundleDev(): Plugin {
  const root = resolve(__dirname, 'dist', 'release-bundle');
  const types: Record<string, string> = { '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
  return {
    name: 'myind-release-bundle-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/release-bundle', (req, res, next) => {
        const path = normalize(decodeURIComponent((req.url ?? '').split('?')[0])).replace(/^[\\/]+/, '');
        const file = resolve(root, path);
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [releaseBundleDev()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        physical: resolve(__dirname, 'physical.html'),
        success: resolve(__dirname, 'success.html'),
        cancel: resolve(__dirname, 'cancel.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
});
