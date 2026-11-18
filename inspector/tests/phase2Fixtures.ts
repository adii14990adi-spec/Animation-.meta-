/**
 * Shared fixtures for Phase 2 tests.
 *
 * Integration tests use the REAL repository assets (74 FBX animations and both
 * character glTFs); mocks are only used for cases the real data cannot produce
 * (malformed FBX, synthetic skeletons for alias/side rules).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../..');
export const animationsDir = path.join(repoRoot, 'animations');

export function animationFileNames(): string[] {
  return fs
    .readdirSync(animationsDir)
    .filter((f) => f.toLowerCase().endsWith('.fbx'))
    .sort((a, b) => a.localeCompare(b));
}

export function readAnimationBuffer(fileName: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(animationsDir, fileName));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function readGltfJson(slot: 'Male' | 'Female'): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'Character', slot, `${slot === 'Male' ? 'Superhero_Male_FullBody' : 'Superhero_Female_FullBody'}.gltf`), 'utf8'));
}

/** Builds a synthetic skeleton from a name/parent spec (for alias & side rules). */
export function syntheticSkeleton(spec: Array<{ name: string; parent: string | null }>) {
  const root = new THREE.Group();
  // Index-keyed (not name-keyed) so intentionally duplicate bone names survive.
  const bones = spec.map((entry) => {
    const bone = new THREE.Bone();
    bone.name = entry.name;
    bone.position.set(0, entry.parent ? 0.1 : 1.0, 0);
    return bone;
  });
  const firstIndexByName = new Map<string, number>();
  spec.forEach((entry, i) => {
    if (!firstIndexByName.has(entry.name)) firstIndexByName.set(entry.name, i);
  });
  spec.forEach((entry, i) => {
    if (entry.parent !== null && firstIndexByName.has(entry.parent)) {
      bones[firstIndexByName.get(entry.parent)!].add(bones[i]);
    } else {
      root.add(bones[i]);
    }
  });
  return root;
}

/** A byte buffer that is not a valid FBX file. */
export function malformedFbxBuffer(): ArrayBuffer {
  const text = 'this is not an fbx file at all';
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** Truncated real FBX header — plausible but corrupt payload. */
export function truncatedFbxBuffer(): ArrayBuffer {
  const header = new Uint8Array([
    0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20, 0x46, 0x42, 0x58, 0x20, 0x42, 0x69, 0x6e, 0x61,
    0x72, 0x79, 0x20, 0x20, 0x00, 0x1a, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00,
  ]);
  return header.buffer as ArrayBuffer;
}
