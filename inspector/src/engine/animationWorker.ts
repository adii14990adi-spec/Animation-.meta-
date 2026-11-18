/// <reference lib="webworker" />
/**
 * Web Worker that parses FBX animations off the main thread.
 *
 * Message protocol
 * ----------------
 * in : { type: 'analyze', jobs: WorkerJob[] }
 *      { type: 'ping' }
 * out: { type: 'result', result: ParsedAnimationResult }
 *      { type: 'progress', done: number, total: number }
 *      { type: 'done', ok: number, failed: number }
 *      { type: 'error', message: string }
 *
 * Each job is independent: a malformed FBX fails that one asset and the batch
 * continues. Parsing is the only expensive step, which is exactly what gets
 * moved here so the UI stays responsive.
 */

import { parseFbxAnimation } from './fbxSkeleton';
import type { ParsedAnimationResult } from './animationTypes';

export interface WorkerJob {
  assetId: string;
  sourcePath: string;
  fileName: string;
  sha256: string;
  buffer: ArrayBuffer;
}

export type WorkerInMessage =
  | { type: 'analyze'; jobs: WorkerJob[] }
  | { type: 'ping' };

export type WorkerOutMessage =
  | { type: 'result'; result: ParsedAnimationResult }
  | { type: 'progress'; done: number; total: number; fileName: string }
  | { type: 'done'; ok: number; failed: number }
  | { type: 'error'; message: string }
  | { type: 'pong' };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === 'ping') {
    ctx.postMessage({ type: 'pong' } satisfies WorkerOutMessage);
    return;
  }

  if (msg.type !== 'analyze') return;

  let ok = 0;
  let failed = 0;
  const total = msg.jobs.length;

  msg.jobs.forEach((job, index) => {
    let result: ParsedAnimationResult;
    try {
      result = parseFbxAnimation(job.buffer, {
        assetId: job.assetId,
        sourcePath: job.sourcePath,
        fileName: job.fileName,
        sha256: job.sha256,
      });
    } catch (err) {
      // Never let one bad asset kill the batch.
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

    if (result.status === 'ok') ok += 1;
    else failed += 1;

    ctx.postMessage({ type: 'result', result } satisfies WorkerOutMessage);
    ctx.postMessage({
      type: 'progress',
      done: index + 1,
      total,
      fileName: job.fileName,
    } satisfies WorkerOutMessage);
  });

  ctx.postMessage({ type: 'done', ok, failed } satisfies WorkerOutMessage);
});
