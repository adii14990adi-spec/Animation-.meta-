import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoCharacterDir = path.resolve(__dirname, '../Character');

interface RepoCharacterManifest {
  male: string[];
  female: string[];
}

function scanRepoCharacters(): RepoCharacterManifest {
  const listSlot = (subDir: string): string[] => {
    const target = path.join(repoCharacterDir, subDir);
    if (!fs.existsSync(target)) return [];
    return fs
      .readdirSync(target, { withFileTypes: true })
      .filter(
        (ent) =>
          ent.isFile() &&
          !ent.name.startsWith('.') &&
          ent.name.trim() !== '. gitkeep',
      )
      .map((ent) => `${subDir}/${ent.name}`)
      .sort();
  };

  return {
    male: listSlot('Male'),
    female: listSlot('Female'),
  };
}

function contentTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.gltf':
      return 'model/gltf+json; charset=utf-8';
    case '.bin':
      return 'application/octet-stream';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Exposes read-only repository character bundles (../Character/Male & ../Character/Female)
 * under ./repo-characters/ during dev and static GitHub Pages builds without duplicating binaries in Git.
 */
function repoCharactersPlugin(): Plugin {
  return {
    name: 'repo-characters-static-bridge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const cleanUrl = req.url.split('?')[0];
        const prefix = '/repo-characters/';
        if (!cleanUrl.startsWith(prefix)) return next();

        const subPath = decodeURIComponent(cleanUrl.slice(prefix.length));
        if (subPath === 'manifest.json') {
          const manifest = scanRepoCharacters();
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(manifest, null, 2));
          return;
        }

        const resolved = path.resolve(repoCharacterDir, subPath);
        if (
          !resolved.startsWith(repoCharacterDir + path.sep) ||
          !fs.existsSync(resolved) ||
          !fs.statSync(resolved).isFile()
        ) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        res.setHeader('Content-Type', contentTypeForFile(resolved));
        fs.createReadStream(resolved).pipe(res);
      });
    },
    writeBundle(outputOptions) {
      const outDir = outputOptions.dir
        ? path.resolve(__dirname, outputOptions.dir)
        : path.resolve(__dirname, 'dist');
      const destRoot = path.join(outDir, 'repo-characters');
      fs.mkdirSync(destRoot, { recursive: true });

      const manifest = scanRepoCharacters();
      fs.writeFileSync(
        path.join(destRoot, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf-8',
      );

      for (const relFile of [...manifest.male, ...manifest.female]) {
        const src = path.join(repoCharacterDir, relFile);
        const dst = path.join(destRoot, relFile);
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        }
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), repoCharactersPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
