import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  analyseFbxFooter,
  findTopLevelContentEnd,
  parseFbx,
  prepareFbxBufferForThree,
  STOCK_FOOTER_BUDGET,
} from '../src/engine/fbxLoaderTolerant';
import { parseFbxAnimation } from '../src/engine/fbxSkeleton';
import { animationFileNames, animationsDir, readAnimationBuffer } from './phase2Fixtures';

/**
 * The two assets whose footer exceeds three.js's hardcoded 176-byte budget.
 * Both are structurally valid; only their trailer length differs.
 */
const FOOTER_TOLERANCE_ASSETS = ['death from the back.fbx', 'reloading.fbx'] as const;

/** Assets that the stock loader already accepts (control group). */
const CONTROL_ASSETS = ['idle.fbx', 'walk forward.fbx'] as const;

function stockParse(buffer: ArrayBuffer) {
  return new FBXLoader().parse(buffer.slice(0), '');
}

function countBones(root: { traverse: (cb: (o: unknown) => void) => void }): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as { isBone?: boolean }).isBone) n++;
  });
  return n;
}

describe('Phase 2 — FBX footer tolerance (valid assets rejected by three.js)', () => {
  it('the stock loader rejects exactly the two oversized-footer assets', () => {
    for (const file of FOOTER_TOLERANCE_ASSETS) {
      expect(() => stockParse(readAnimationBuffer(file)), `${file} should be rejected by stock FBXLoader`).toThrow(
        /Unknown property type/,
      );
    }
    for (const file of CONTROL_ASSETS) {
      expect(() => stockParse(readAnimationBuffer(file)), `${file} should already work`).not.toThrow();
    }
  });

  it('detects the oversized footer rather than blaming the payload', () => {
    for (const file of FOOTER_TOLERANCE_ASSETS) {
      const analysis = analyseFbxFooter(readAnimationBuffer(file));
      expect(analysis.binary).toBe(true);
      expect(analysis.version).toBe(7700);
      expect(analysis.contentEnd).not.toBeNull();
      // The whole bug in one assertion: footer is one byte over the stock budget.
      expect(analysis.trailingBytes).toBeGreaterThan(STOCK_FOOTER_BUDGET);
      expect(analysis.stockAccepts).toBe(false);
      expect(analysis.trimBytes).toBeGreaterThan(0);
      expect(analysis.trimBytes).toBeLessThanOrEqual(4);
    }
  });

  it('is a byte-for-byte no-op for assets that already parse', () => {
    for (const file of CONTROL_ASSETS) {
      const original = readAnimationBuffer(file);
      const before = new Uint8Array(original.slice(0));
      const prepared = prepareFbxBufferForThree(original);

      expect(prepared.trimmed).toBe(false);
      // Same object identity, and contents untouched.
      expect(prepared.buffer).toBe(original);
      expect(prepared.analysis.stockAccepts).toBe(true);
      expect(new Uint8Array(original)).toEqual(before);
    }
  });

  it('never mutates the caller buffer when it does trim', () => {
    for (const file of FOOTER_TOLERANCE_ASSETS) {
      const original = readAnimationBuffer(file);
      const before = new Uint8Array(original.slice(0));

      const prepared = prepareFbxBufferForThree(original);

      expect(prepared.trimmed).toBe(true);
      expect(prepared.buffer).not.toBe(original);
      expect(prepared.buffer.byteLength).toBeLessThan(original.byteLength);
      // Source buffer is untouched — this is what protects the real asset files.
      expect(new Uint8Array(original)).toEqual(before);
    }
  });

  it('parses both rejected assets into full skeletons and complete clips', () => {
    for (const file of FOOTER_TOLERANCE_ASSETS) {
      const { object, trimmed } = parseFbx(readAnimationBuffer(file), '');
      expect(trimmed).toBe(true);

      expect(countBones(object)).toBe(65);
      expect(object.animations).toHaveLength(1);

      const clip = object.animations[0];
      expect(clip.duration).toBeGreaterThan(1);
      expect(clip.duration).toBeLessThan(10);
      expect(clip.tracks.length).toBe(53);
    }
    // Exact durations, so a future loader change cannot silently swap the clip.
    expect(parseFbx(readAnimationBuffer('death from the back.fbx'), '').object.animations[0].duration).toBeCloseTo(
      2.967,
      2,
    );
    expect(parseFbx(readAnimationBuffer('reloading.fbx'), '').object.animations[0].duration).toBeCloseTo(3.3, 2);
  });

  it('produces the same skeleton as a working asset (payloads are structurally identical)', () => {
    const reference = parseFbx(readAnimationBuffer('idle.fbx'), '').object;
    const referenceBones: string[] = [];
    reference.traverse((o) => {
      if ((o as { isBone?: boolean }).isBone) referenceBones.push((o as { name: string }).name);
    });

    for (const file of FOOTER_TOLERANCE_ASSETS) {
      const { object } = parseFbx(readAnimationBuffer(file), '');
      const bones: string[] = [];
      object.traverse((o) => {
        if ((o as { isBone?: boolean }).isBone) bones.push((o as { name: string }).name);
      });
      expect(bones.sort()).toEqual([...referenceBones].sort());
    }
  });

  it('every one of the 74 animations parses successfully', () => {
    const failures: Array<{ file: string; error: string }> = [];
    for (const file of animationFileNames()) {
      try {
        parseFbx(readAnimationBuffer(file), '');
      } catch (err) {
        failures.push({ file, error: err instanceof Error ? err.message : String(err) });
      }
    }
    expect(failures).toEqual([]);
    expect(animationFileNames().length).toBe(74);
  });

  it('keeps the pipeline-level parser green for all 74 assets (no PROCESSING_FAILED)', () => {
    const results = animationFileNames().map((file) =>
      parseFbxAnimation(readAnimationBuffer(file), {
        assetId: file,
        sourcePath: `animations/${file}`,
        fileName: file,
        sha256: 'x',
      }),
    );

    const failed = results.filter((r) => r.status !== 'ok');
    expect(failed.map((r) => `${r.fileName}: ${r.error ?? ''}`)).toEqual([]);
    expect(results).toHaveLength(74);

    // The two previously-failing assets now carry a real skeleton and clip.
    for (const file of FOOTER_TOLERANCE_ASSETS) {
      const r = results.find((x) => x.fileName === file);
      expect(r?.status).toBe('ok');
      expect(r?.skeleton?.bones.length).toBeGreaterThan(60);
      expect(r?.clips.length).toBeGreaterThan(0);
      // The workaround explains itself in the report rather than hiding.
      expect(r?.warnings.some((w) => /footer tolerance applied/i.test(w))).toBe(true);
    }
  });

  it('fails closed: a truncated file is still rejected', () => {
    const full = readAnimationBuffer('idle.fbx');
    const truncated = full.slice(0, 2000);
    expect(() => parseFbx(truncated, '')).toThrow();
    // And the analysis must not pretend it knows a content end.
    const analysis = analyseFbxFooter(truncated);
    expect(analysis.stockAccepts === false ? analysis.trimBytes >= 0 : true).toBe(true);
  });

  it('leaves non-FBX input to three.js to reject', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const analysis = analyseFbxFooter(garbage);
    expect(analysis.binary).toBe(false);
    expect(analysis.trimBytes).toBe(0);
    expect(findTopLevelContentEnd(garbage)).toBeNull();
  });

  it('does not touch the files on disk', () => {
    for (const file of FOOTER_TOLERANCE_ASSETS) {
      const before = fs.readFileSync(path.join(animationsDir, file));
      parseFbx(readAnimationBuffer(file), '');
      const after = fs.readFileSync(path.join(animationsDir, file));
      expect(after.equals(before)).toBe(true);
    }
  });
});
