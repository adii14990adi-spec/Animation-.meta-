/**
 * Animation asset discovery.
 *
 * Discovery is *directory-driven*, never a hardcoded filename list: the caller
 * supplies the directory manifest produced by the Vite plugin (which walks
 * `animations/`), and this module classifies what it finds.
 */

import type { AnimationAssetEntry, AnimationDiscoveryReport } from './animationTypes';
import { categorizeAnimation } from './compatibility';

/** Directories treated as animation sources. */
export const ANIMATION_DIRECTORIES = ['animations'];

/** Directories that must never be counted as animation assets. */
export const NON_ANIMATION_DIRECTORIES = ['Character'];

/** The repository is expected to contain exactly this many animation FBX files. */
export const EXPECTED_ANIMATION_COUNT = 74;

export interface DiscoveredFile {
  /** Repository-relative POSIX path, e.g. `animations/idle.fbx`. */
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface DiscoveryOptions {
  directories?: string[];
  expectedCount?: number | null;
}

function isAnimationFbx(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.fbx')) return false;
  // Companion files are not assets.
  if (lower.endsWith('.fbx.meta')) return false;
  return true;
}

function isExcluded(path: string): { excluded: boolean; reason: string } {
  const lower = path.toLowerCase();
  if (lower.endsWith('.fbx.meta')) {
    return { excluded: true, reason: 'Unity .meta sidecar — not an animation asset' };
  }
  if (NON_ANIMATION_DIRECTORIES.some((d) => lower.startsWith(`${d.toLowerCase()}/`))) {
    return { excluded: true, reason: 'Character bundle directory — not an animation library asset' };
  }
  if (!lower.endsWith('.fbx')) {
    return { excluded: true, reason: 'Not an FBX file' };
  }
  return { excluded: false, reason: '' };
}

/**
 * Builds the discovery report from a directory listing.
 * De-duplication is SHA-256 based; the first path (sorted) is the canonical asset
 * and later identical files are recorded as duplicates instead of being dropped.
 */
export function buildDiscoveryReport(
  files: DiscoveredFile[],
  options: DiscoveryOptions = {},
): AnimationDiscoveryReport {
  const directories = options.directories ?? ANIMATION_DIRECTORIES;
  const expectedCount = options.expectedCount === undefined ? EXPECTED_ANIMATION_COUNT : options.expectedCount;

  const inScope = files.filter((f) => directories.some((d) => f.path.toLowerCase().startsWith(`${d.toLowerCase()}/`)));
  const excluded: Array<{ sourcePath: string; reason: string }> = [];

  for (const f of files) {
    const { excluded: isEx, reason } = isExcluded(f.path);
    if (isEx) excluded.push({ sourcePath: f.path, reason });
  }

  const candidates = inScope
    .filter((f) => isAnimationFbx(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const byHash = new Map<string, string>();
  const assets: AnimationAssetEntry[] = candidates.map((file) => {
    const notes: string[] = [];
    const existing = byHash.get(file.sha256);
    if (existing) notes.push(`Byte-identical to ${existing} (SHA-256 match).`);
    else byHash.set(file.sha256, file.path);

    return {
      id: file.path,
      sourcePath: file.path,
      fileName: file.path.split('/').pop() ?? file.path,
      category: categorizeAnimation(file.path.split('/').pop() ?? file.path),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      notes,
      duplicateOf: existing ?? null,
    };
  });

  const duplicates = assets.filter((a) => a.duplicateOf !== null).length;

  return {
    scannedDirectories: directories,
    totalFilesScanned: files.length,
    animationFiles: assets.length,
    duplicates,
    excluded: excluded.slice(0, 200),
    assets,
    expectedCount,
    matchesExpectedCount: expectedCount === null ? true : assets.length === expectedCount,
    discoveryStrategy:
      'Recursive directory manifest scan of the configured animation directories; classification by extension and path, duplicate detection by SHA-256. No filename allow-list is used.',
  };
}

/** Free-text + facet filtering used by the animation library UI. */
export function filterAssets(
  assets: AnimationAssetEntry[],
  opts: { query?: string; category?: string | null; statuses?: string[] | null; statusOf?: (assetId: string) => string | undefined },
): AnimationAssetEntry[] {
  const query = (opts.query ?? '').trim().toLowerCase();
  return assets.filter((a) => {
    if (query && !a.fileName.toLowerCase().includes(query) && !a.sourcePath.toLowerCase().includes(query)) {
      return false;
    }
    if (opts.category && a.category !== opts.category) return false;
    if (opts.statuses && opts.statuses.length > 0) {
      const status = opts.statusOf?.(a.id);
      if (!status || !opts.statuses.includes(status)) return false;
    }
    return true;
  });
}
