import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDiscoveryReport,
  type DiscoveredFile,
} from '../src/engine/animationDiscovery';
import { parseAnimationBatch, sha256Hex } from '../src/engine/animationLibrary';
import { buildCharacterRigFromGltf } from '../src/engine/characterRig';
import { runPhase2, selectFirstTestAnimation } from '../src/engine/phase2Pipeline';
import type { ParsedAnimationResult } from '../src/engine/animationTypes';
import { animationFileNames, animationsDir, malformedFbxBuffer, readGltfJson } from './phase2Fixtures';

function repoFiles(): DiscoveredFile[] {
  return animationFileNames().map((name) => {
    const bytes = fs.readFileSync(path.join(animationsDir, name));
    return {
      path: `animations/${name}`,
      sizeBytes: bytes.byteLength,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

function repoBuffers(): Map<string, ArrayBuffer> {
  const map = new Map<string, ArrayBuffer>();
  for (const name of animationFileNames()) {
    const buf = fs.readFileSync(path.join(animationsDir, name));
    map.set(`animations/${name}`, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  }
  return map;
}

const discovery = buildDiscoveryReport(repoFiles());
const buffers = repoBuffers();
const maleRig = buildCharacterRigFromGltf(readGltfJson('Male') as never);
const femaleRig = buildCharacterRigFromGltf(readGltfJson('Female') as never);

describe('Phase 2 — batch processing', () => {
  it('processes a small subset without touching the rest', async () => {
    const only = ['animations/idle.fbx', 'animations/walking.fbx'];
    const result = await parseAnimationBatch({
      assets: discovery.assets,
      buffers,
      only,
      useWorker: false,
    });
    expect(result.results.length).toBe(2);
    expect(result.results.every((r) => r.status === 'ok')).toBe(true);
    expect(result.ok).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('isolates a malformed FBX so the rest of the batch succeeds', async () => {
    const assets = [
      discovery.assets.find((a) => a.id === 'animations/idle.fbx')!,
      {
        ...discovery.assets[0],
        id: 'animations/corrupt.fbx',
        sourcePath: 'animations/corrupt.fbx',
        fileName: 'corrupt.fbx',
        sha256: 'corrupt-hash',
      },
      discovery.assets.find((a) => a.id === 'animations/walking.fbx')!,
    ];
    const withCorrupt = new Map(buffers);
    withCorrupt.set('animations/corrupt.fbx', malformedFbxBuffer());

    const result = await parseAnimationBatch({ assets, buffers: withCorrupt, useWorker: false });

    expect(result.results.length).toBe(3);
    expect(result.ok).toBe(2);
    expect(result.failed).toBe(1);
    const corrupt = result.results.find((r) => r.assetId === 'animations/corrupt.fbx')!;
    expect(corrupt.status).toBe('failed');
    expect(corrupt.error).toBeTruthy();
  });

  it('caches results by SHA-256 and does not reprocess them', async () => {
    const cache = new Map<string, ParsedAnimationResult>();
    const only = ['animations/idle.fbx'];

    const first = await parseAnimationBatch({ assets: discovery.assets, buffers, only, useWorker: false, cache });
    expect(first.cachedHits).toBe(0);
    expect(cache.size).toBe(1);

    const parseSpy = vi.fn();
    const second = await parseAnimationBatch({
      assets: discovery.assets,
      buffers,
      only,
      useWorker: false,
      cache,
      onResult: parseSpy,
    });
    expect(second.cachedHits).toBe(1);
    // The cached result is re-emitted without re-parsing.
    expect(second.results[0].parseMs).toBe(first.results[0].parseMs);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('reports progress with monotonic counters', async () => {
    const events: Array<{ done: number; total: number }> = [];
    await parseAnimationBatch({
      assets: discovery.assets,
      buffers,
      only: ['animations/idle.fbx', 'animations/idle crouching.fbx'],
      useWorker: false,
      onProgress: (p) => events.push({ done: p.done, total: p.total }),
    });
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].done).toBeGreaterThanOrEqual(events[i - 1].done);
      expect(events[i].total).toBe(2);
    }
    expect(events[events.length - 1].done).toBe(2);
  });

  it('supports retrying only the failed assets', async () => {
    const assets = [
      discovery.assets.find((a) => a.id === 'animations/idle.fbx')!,
      {
        ...discovery.assets[0],
        id: 'animations/bad-unique.fbx',
        sourcePath: 'animations/bad-unique.fbx',
        fileName: 'bad-unique.fbx',
        sha256: 'bad-unique',
      },
    ];
    const map = new Map(buffers);
    map.set('animations/bad-unique.fbx', malformedFbxBuffer());

    const first = await parseAnimationBatch({ assets, buffers: map, useWorker: false });
    const failedIds = first.results.filter((r) => r.status !== 'ok').map((r) => r.assetId);
    expect(failedIds).toEqual(['animations/bad-unique.fbx']);

    // Retry only the failed one, with a now-valid buffer.
    map.set('animations/bad-unique.fbx', buffers.get('animations/walking.fbx')!);
    const retry = await parseAnimationBatch({
      assets,
      buffers: map,
      only: failedIds,
      useWorker: false,
      cache: new Map(),
    });
    expect(retry.results.length).toBe(1);
    expect(retry.results[0].status).toBe('ok');
  });

  it('survives a batch where every asset is malformed', async () => {
    const assets = discovery.assets.slice(0, 3).map((a) => ({ ...a, sha256: `bad-${a.id}` }));
    const map = new Map<string, ArrayBuffer>();
    for (const a of assets) map.set(a.sourcePath, malformedFbxBuffer());

    const result = await parseAnimationBatch({ assets, buffers: map, useWorker: false });
    expect(result.ok).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.results.length).toBe(3);
  });
});

describe('Phase 2 — full pipeline over all 74 animations', () => {
  it('runs discovery -> parse -> compatibility for both characters', async () => {
    const result = await runPhase2({
      discovery,
      buffers,
      maleRig,
      femaleRig,
      useWorker: false,
    });

    expect(result.bundle.discovery.animationFiles).toBe(74);
    expect(result.bundle.animations.length).toBe(74);
    expect(result.ok).toBe(72);
    expect(result.failed).toBe(2);

    // One report per animation per character.
    expect(result.bundle.compatibility.length).toBe(74 * 2);
    expect(result.bundle.compatibility.filter((c) => c.characterSlot === 'male').length).toBe(74);
    expect(result.bundle.compatibility.filter((c) => c.characterSlot === 'female').length).toBe(74);

    // Mapping profiles for every parsed animation, per character.
    expect(result.bundle.mappings.length).toBe(72 * 2);

    // The two malformed files must be PROCESSING_FAILED, never silently dropped.
    const failedReports = result.bundle.compatibility.filter((c) => c.status === 'PROCESSING_FAILED');
    expect(failedReports.length).toBe(4); // 2 files × 2 characters
    expect(new Set(failedReports.map((r) => r.fileName))).toEqual(
      new Set(['death from the back.fbx', 'reloading.fbx']),
    );

    // Every parsed animation must be retarget-ready on both characters.
    const ready = result.bundle.compatibility.filter(
      (c) => c.status !== 'PROCESSING_FAILED' && c.retargetReadiness !== 'not_ready',
    );
    expect(ready.length).toBe(72 * 2);
  }, 120000);

  it('automatically selects a real Idle/Walk for the first end-to-end test', () => {
    const fakeCompat = discovery.assets.map((a) => ({
      assetId: a.id,
      characterSlot: 'male' as const,
      scoring: { requiredSlotCoverage: 1 },
      // Only the fields used by the selector matter here.
    })) as never[];

    const pick = selectFirstTestAnimation(discovery.assets, fakeCompat)!;
    expect(pick.category).toBe('Idle');
    expect(['Idle', 'Walk']).toContain(pick.category);
    // Prefers the plain "idle.fbx" over longer idle variants.
    expect(pick.fileName).toBe('idle.fbx');
  });
});

describe('Phase 2 — hashing', () => {
  it('hashes buffers with SHA-256', async () => {
    const buffer = new TextEncoder().encode('hello world').buffer as ArrayBuffer;
    const hash = await sha256Hex(buffer);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });
});
