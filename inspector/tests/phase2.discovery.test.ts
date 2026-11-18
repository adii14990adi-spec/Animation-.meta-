import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANIMATION_DIRECTORIES,
  EXPECTED_ANIMATION_COUNT,
  buildDiscoveryReport,
  filterAssets,
  type DiscoveredFile,
} from '../src/engine/animationDiscovery';
import { categorizeAnimation } from '../src/engine/compatibility';
import { animationFileNames, animationsDir, repoRoot } from './phase2Fixtures';

/** Builds a DiscoveredFile list from the real repository animations directory. */
function realDiscoveredFiles(): DiscoveredFile[] {
  return animationFileNames().map((name) => {
    const full = path.join(animationsDir, name);
    const bytes = fs.readFileSync(full);
    return {
      path: `animations/${name}`,
      sizeBytes: bytes.byteLength,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

describe('Phase 2 — animation discovery', () => {
  it('discovers exactly the 74 repository animation FBX files', async () => {
    const files = realDiscoveredFiles();
    const report = buildDiscoveryReport(files);

    expect(report.animationFiles).toBe(EXPECTED_ANIMATION_COUNT);
    expect(report.animationFiles).toBe(74);
    expect(report.matchesExpectedCount).toBe(true);
    expect(report.assets.length).toBe(74);
    expect(report.discoveryStrategy).toMatch(/No filename allow-list/i);
  });

  it('does not hardcode filenames: deriving from an empty listing yields zero assets', () => {
    const report = buildDiscoveryReport([]);
    expect(report.animationFiles).toBe(0);
    expect(report.assets).toEqual([]);
    expect(report.matchesExpectedCount).toBe(false);
  });

  it('discovers a newly added file without code changes', () => {
    const files = realDiscoveredFiles();
    files.push({ path: 'animations/brand new motion.fbx', sizeBytes: 10, sha256: 'deadbeef' });
    const report = buildDiscoveryReport(files);
    expect(report.animationFiles).toBe(75);
    expect(report.assets.some((a) => a.fileName === 'brand new motion.fbx')).toBe(true);
  });

  it('never counts .fbx.meta sidecars or Character bundle FBX as animation assets', () => {
    const files: DiscoveredFile[] = [
      { path: 'animations/idle.fbx', sizeBytes: 1, sha256: 'a' },
      { path: 'animations/idle.fbx.meta', sizeBytes: 1, sha256: 'b' },
      { path: 'Character/Male/Superhero_Male_FullBody.fbx', sizeBytes: 1, sha256: 'c' },
      { path: 'animations/readme.txt', sizeBytes: 1, sha256: 'd' },
    ];
    const report = buildDiscoveryReport(files);

    expect(report.animationFiles).toBe(1);
    expect(report.assets.map((a) => a.fileName)).toEqual(['idle.fbx']);
    expect(report.excluded.some((e) => e.sourcePath.endsWith('.fbx.meta'))).toBe(true);
    expect(report.excluded.some((e) => e.sourcePath.startsWith('Character/'))).toBe(true);
  });

  it('scans only the configured animation directories', () => {
    const report = buildDiscoveryReport(realDiscoveredFiles());
    expect(report.scannedDirectories).toEqual(ANIMATION_DIRECTORIES);
    expect(ANIMATION_DIRECTORIES).toEqual(['animations']);
  });

  it('detects duplicate files by SHA-256', () => {
    const real = fs.readFileSync(path.join(animationsDir, 'idle.fbx'));
    const sha = crypto.createHash('sha256').update(real).digest('hex');
    const files: DiscoveredFile[] = [
      { path: 'animations/a first.fbx', sizeBytes: real.byteLength, sha256: sha },
      { path: 'animations/b copy.fbx', sizeBytes: real.byteLength, sha256: sha },
      { path: 'animations/c other.fbx', sizeBytes: 5, sha256: 'different' },
    ];
    const report = buildDiscoveryReport(files);

    expect(report.duplicates).toBe(1);
    const copy = report.assets.find((a) => a.fileName === 'b copy.fbx')!;
    expect(copy.duplicateOf).toBe('animations/a first.fbx');
    expect(copy.notes.join(' ')).toMatch(/Byte-identical/);
  });

  it('the real repository has no byte-identical duplicate animations', () => {
    const report = buildDiscoveryReport(realDiscoveredFiles());
    expect(report.duplicates).toBe(0);
  });

  it('classifies categories from filenames', () => {
    expect(categorizeAnimation('idle.fbx')).toBe('Idle');
    expect(categorizeAnimation('walk forward.fbx')).toBe('Walk');
    expect(categorizeAnimation('sprint left.fbx')).toBe('Sprint');
    expect(categorizeAnimation('death from front.fbx')).toBe('Death');
    expect(categorizeAnimation('rifle aiming idle.fbx')).toBe('Weapon');
  });

  it('supports search + category + status filtering', () => {
    const report = buildDiscoveryReport(realDiscoveredFiles());
    const idle = filterAssets(report.assets, { query: 'idle' });
    expect(idle.length).toBeGreaterThan(0);
    expect(idle.every((a) => a.fileName.toLowerCase().includes('idle'))).toBe(true);

    const walks = filterAssets(report.assets, { category: 'Walk' });
    expect(walks.length).toBeGreaterThan(10);
    expect(walks.every((a) => a.category === 'Walk')).toBe(true);

    // `idle.fbx` alone is COMPATIBLE; note "rifle aiming idle.fbx" also ends in
    // "idle.fbx", which is exactly the case a substring filter must not confuse.
    const onlyCompatible = filterAssets(report.assets, {
      statuses: ['COMPATIBLE'],
      statusOf: (id) => (id === 'animations/idle.fbx' ? 'COMPATIBLE' : 'INCOMPATIBLE'),
    });
    expect(onlyCompatible.length).toBe(1);
    expect(onlyCompatible[0].fileName).toBe('idle.fbx');
  });

  it('records size, source path and category for every asset', () => {
    const report = buildDiscoveryReport(realDiscoveredFiles());
    for (const asset of report.assets) {
      expect(asset.sourcePath.startsWith('animations/')).toBe(true);
      expect(asset.sizeBytes).toBeGreaterThan(1000);
      expect(asset.category.length).toBeGreaterThan(0);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // Character directory exists but contributes nothing.
    expect(fs.existsSync(path.join(repoRoot, 'Character'))).toBe(true);
  });
});
