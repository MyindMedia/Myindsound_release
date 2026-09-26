/**
 * Release bundles for the app (PRD §10, BUN-0, BUN-1). `npm run bundle:lit` builds `bundles/lit` into
 * `dist-bundles/lit`; `scripts/build-bundle.mjs` zips it with its manifest.
 *
 * The bundle composes the site's own `src/player3d/` with the bridge, so web and app never drift. Everything it
 * loads is inside the zip and addressed relatively, because it runs from `myind-bundle://lit/index.html` (BUN-3)
 * with no network: no CDN, no Google Fonts, no Convex, no audio files (BUN-5).
 */
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const ROOT = __dirname;
const SLUG = process.env.BUNDLE_SLUG ?? 'lit';
const BUNDLE_DIR = resolve(ROOT, 'bundles', SLUG);
const OUT_DIR = resolve(ROOT, 'dist-bundles', SLUG);

/**
 * The site files the player loads at run time, copied from `public/` into the bundle. The song previews
 * (`assets/audio/lit-previews`) are deliberately absent: music only ever comes from native (ARCH-2).
 */
const SITE_ASSETS = [
  'assets/images/minidisc',
  'assets/images/lit-sleeve.webp',
  'assets/audio/disc',
  'assets/audio/wrap',
];

/**
 * The player's modules address their textures and sounds as `/assets/...` (the site is served from its root).
 * In the bundle every such literal becomes `./assets/...`, resolved against the entry HTML, so the bundle works
 * wherever it is mounted. Runs after the JSON plugin, so `disc-sounds.json` and `wrap-sounds.json` are covered.
 */
function relativeAssetPaths(): Plugin {
  const scoped = /[\\/](src[\\/]player3d|bundles)[\\/]/;
  return {
    name: 'myind-relative-asset-paths',
    enforce: 'post',
    transform(code, id) {
      if (!scoped.test(id) || !code.includes('/assets/')) return null;
      const next = code.replace(/(["'`])\/assets\//g, '$1./assets/');
      return next === code ? null : { code: next, map: null };
    },
  };
}

/** Copies SITE_ASSETS into the output (build), and serves them from `public/` (dev server). */
function siteAssets(): Plugin {
  return {
    name: 'myind-site-assets',
    apply: 'build',
    closeBundle() {
      for (const path of SITE_ASSETS) {
        const from = resolve(ROOT, 'public', path);
        if (!existsSync(from)) throw new Error(`Bundle asset missing: public/${path}`);
        const to = join(OUT_DIR, path);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
      }
      // Guard: nothing that sounds like music made it in (BUN-5, ARCH-2).
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
      const music = walk(OUT_DIR).filter((f) => /lit-previews|[\\/]audio[\\/](?!disc|wrap)/.test(f));
      if (music.length > 0) throw new Error(`Bundle must not carry music: ${music.join(', ')}`);
    },
  };
}

const TYPES: Record<string, string> = { '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.png': 'image/png' };

/** Dev server only (`npx vite -c vite.bundles.config.ts`): serves SITE_ASSETS straight from `public/`. */
function siteAssetsDev(): Plugin {
  return {
    name: 'myind-site-assets-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = normalize(decodeURIComponent((req.url ?? '').split('?')[0])).replace(/^[\\/]+/, '');
        if (!SITE_ASSETS.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))) return next();
        const file = resolve(ROOT, 'public', path);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: BUNDLE_DIR,
  base: './',
  publicDir: resolve(BUNDLE_DIR, 'public'),
  // The bundle reads no VITE_* settings: it never talks to Convex, Clerk or PostHog.
  envDir: BUNDLE_DIR,
  plugins: [relativeAssetPaths(), siteAssets(), siteAssetsDev()],
  server: {
    fs: { allow: [ROOT] },
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: 'es2022',
    // Everything stays a file, so the zip is inspectable and nothing depends on data: URIs.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: resolve(BUNDLE_DIR, 'index.html'),
        // The desktop harness (MockBridge). Built alongside for testing; left out of the release zip.
        dev: resolve(BUNDLE_DIR, 'dev.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
