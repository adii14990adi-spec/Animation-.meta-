/**
 * Browser-side animation library: fetch the directory manifest, hash the bytes,
 * discover the assets, then parse them in a Web Worker with SHA-256 based caching.
 */

import type {
  AnimationAssetEntry,
  AnimationDiscoveryReport,
  ParsedAnimationResult,
} from './animationTypes';
import { buildDiscoveryReport, type DiscoveredFile } from './animationDiscovery';
import type { WorkerInMessage, WorkerJob, WorkerOutMessage } from './animationWorker';

export interface AnimationManifest {
  directory: string;
  files: string[];
}

/** Fetches the generated animation manifest (directory listing, not a hardcoded list). */
export async function fetchAnimationManifest(): Promise<AnimationManifest | null> {
  try {
    const res = await fetch('./repo-animations/manifest.json');
    if (!res.ok) return null;
    const data = (await res.json()) as AnimationManifest;
    if (!data || !Array.isArray(data.files)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Streams an animation FBX and hashes it. */
export async function fetchAnimationBytes(
  sourcePath: string,
): Promise<{ buffer: ArrayBuffer; sizeBytes: number; sha256: string } | null> {
  const encoded = sourcePath
    .replace(/^animations\//, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  try {
    const res = await fetch(`./repo-animations/${encoded}`);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const sha256 = await sha256Hex(buffer);
    return { buffer, sizeBytes: buffer.byteLength, sha256 };
  } catch {
    return null;
  }
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Deterministic non-crypto fallback (cache key only; never used for integrity claims).
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i++) {
    h1 = (h1 ^ view[i]) * 16777619 >>> 0;
    h2 = (h2 + view[i] * (i + 1)) >>> 0;
  }
  return `fnv-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}-${view.length}`;
}

export interface DiscoveryWithBytes {
  report: AnimationDiscoveryReport;
  buffers: Map<string, ArrayBuffer>;
}

/** Fetches + hashes every animation, then builds the discovery report. */
export async function discoverAnimations(
  onProgress?: (done: number, total: number, fileName: string) => void,
): Promise<DiscoveryWithBytes> {
  const manifest = await fetchAnimationManifest();
  if (!manifest) {
    throw new Error(
      'Animation manifest not found (./repo-animations/manifest.json). Run the app through Vite so the repository bridge is available.',
    );
  }

  const buffers = new Map<string, ArrayBuffer>();
  const discovered: DiscoveredFile[] = [];
  let done = 0;

  for (const path of manifest.files) {
    const fetched = await fetchAnimationBytes(path);
    done += 1;
    onProgress?.(done, manifest.files.length, path.split('/').pop() ?? path);
    if (!fetched) continue;
    buffers.set(path, fetched.buffer);
    discovered.push({ path, sizeBytes: fetched.sizeBytes, sha256: fetched.sha256 });
  }

  return { report: buildDiscoveryReport(discovered), buffers };
}

export interface BatchProgress {
  phase: 'discovering' | 'parsing' | 'analyzing' | 'done' | 'error';
  done: number;
  total: number;
  current: string;
  ok: number;
  failed: number;
  message?: string;
}

export interface ParseBatchOptions {
  assets: AnimationAssetEntry[];
  buffers: Map<string, ArrayBuffer>;
  /** Cached results keyed by SHA-256; reused to avoid reprocessing unchanged files. */
  cache?: Map<string, ParsedAnimationResult>;
  useWorker?: boolean;
  onProgress?: (progress: BatchProgress) => void;
  onResult?: (result: ParsedAnimationResult) => void;
  /** Assets to (re)process; defaults to all assets. */
  only?: string[];
}

export interface ParseBatchResult {
  results: ParsedAnimationResult[];
  cache: Map<string, ParsedAnimationResult>;
  ok: number;
  failed: number;
  cachedHits: number;
  workerUsed: boolean;
}

function parseInMainThread(job: WorkerJob): ParsedAnimationResult {
  // Lazily imported so the worker path never pays for this module twice.
  throw new Error('main-thread parse must be supplied by caller');
  void job;
}

/**
 * Parses a batch of animations, preferring a Web Worker and falling back to the
 * main thread when workers are unavailable (e.g. some embedded webviews).
 */
export async function parseAnimationBatch(
  options: ParseBatchOptions,
): Promise<ParseBatchResult> {
  const cache = options.cache ?? new Map<string, ParsedAnimationResult>();
  const results: ParsedAnimationResult[] = [];
  const targets = options.only
    ? options.assets.filter((a) => options.only!.includes(a.id))
    : options.assets;

  let cachedHits = 0;
  const pending: WorkerJob[] = [];
  for (const asset of targets) {
    const hit = cache.get(asset.sha256);
    if (hit) {
      results.push(hit);
      cachedHits += 1;
      options.onResult?.(hit);
      continue;
    }
    const buffer = options.buffers.get(asset.sourcePath);
    if (!buffer) continue;
    pending.push({
      assetId: asset.id,
      sourcePath: asset.sourcePath,
      fileName: asset.fileName,
      sha256: asset.sha256,
      buffer,
    });
  }

  let ok = results.filter((r) => r.status === 'ok').length;
  let failed = results.filter((r) => r.status !== 'ok').length;
  let workerUsed = false;

  const total = targets.length;
  let done = cachedHits;
  options.onProgress?.({
    phase: 'parsing',
    done,
    total,
    current: cachedHits > 0 ? `${cachedHits} cached` : '',
    ok,
    failed,
  });

  const recordResult = (result: ParsedAnimationResult) => {
    results.push(result);
    cache.set(result.sha256, result);
    if (result.status === 'ok') ok += 1;
    else failed += 1;
    options.onResult?.(result);
  };

  const canUseWorker =
    options.useWorker !== false &&
    typeof Worker !== 'undefined' &&
    pending.length > 0;

  if (canUseWorker) {
    try {
      await new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL('./animationWorker.ts', import.meta.url), {
          type: 'module',
        });
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          worker.terminate();
          if (err) reject(err);
          else resolve();
        };

        worker.addEventListener('message', (event: MessageEvent<WorkerOutMessage>) => {
          const msg = event.data;
          if (msg.type === 'result') {
            recordResult(msg.result);
          } else if (msg.type === 'progress') {
            done = cachedHits + msg.done;
            options.onProgress?.({
              phase: 'parsing',
              done,
              total,
              current: msg.fileName,
              ok,
              failed,
            });
          } else if (msg.type === 'done') {
            finish();
          } else if (msg.type === 'error') {
            finish(new Error(msg.message));
          }
        });
        worker.addEventListener('error', (e) => finish(new Error(e.message || 'Worker failed')));
        worker.postMessage({ type: 'analyze', jobs: pending } satisfies WorkerInMessage);
      });
      workerUsed = true;
    } catch {
      // Fall back to the main thread below.
      results.length = 0;
      ok = 0;
      failed = 0;
      for (const [hash, cached] of cache) {
        if (targets.some((t) => t.sha256 === hash)) {
          results.push(cached);
          if (cached.status === 'ok') ok += 1;
          else failed += 1;
        }
      }
      workerUsed = false;
    }
  }

  if (!workerUsed && pending.length > 0) {
    const { parseFbxAnimation } = await import('./fbxSkeleton');
    for (const [i, job] of pending.entries()) {
      let result: ParsedAnimationResult;
      try {
        result = parseFbxAnimation(job.buffer, {
          assetId: job.assetId,
          sourcePath: job.sourcePath,
          fileName: job.fileName,
          sha256: job.sha256,
        });
      } catch (err) {
        result = {
          assetId: job.assetId,
          sourcePath: job.sourcePath,
          fileName: job.fileName,
          sha256: job.sha256,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          parseMs: 0,
          skeleton: null,
          clips: [],
          durationSeconds: null,
          warnings: [],
        };
      }
      recordResult(result);
      options.onProgress?.({
        phase: 'parsing',
        done: cachedHits + i + 1,
        total,
        current: job.fileName,
        ok,
        failed,
      });
      // Yield so the UI can paint between assets.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Keep result ordering deterministic (repository order).
  orderResults(results, targets);
  void parseInMainThread;

  return { results, cache, ok, failed, cachedHits, workerUsed };
}

function orderResults(results: ParsedAnimationResult[], targets: AnimationAssetEntry[]): void {
  const rank = new Map(targets.map((t, i) => [t.id, i]));
  results.sort((a, b) => (rank.get(a.assetId) ?? 0) - (rank.get(b.assetId) ?? 0));
}
