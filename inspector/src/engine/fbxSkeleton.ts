/**
 * Converts a Three.js `FBXLoader` parse result into the transportable
 * `NormalizedSkeleton` / `AnimationClipSummary` representation used by the
 * Phase 2 analysis pipeline.
 *
 * FBXLoader is a browser-oriented loader: it is instantiated with an
 * `ArrayBuffer` and returns a `THREE.Group` plus `animations`. Everything below
 * only reads from that result — it never mutates the source file bytes.
 */

import * as THREE from 'three';
import { parseFbx, STOCK_FOOTER_BUDGET } from './fbxLoaderTolerant';
import type {
  AnimationClipSummary,
  NormalizedBone,
  NormalizedSkeleton,
  ParsedAnimationResult,
} from './animationTypes';
import { detectHumanoidSlots } from './humanoidRegistry';

export interface ParseAnimationOptions {
  assetId: string;
  sourcePath: string;
  fileName: string;
  sha256: string;
}

function trackTargetName(trackName: string): string {
  const dot = trackName.lastIndexOf('.');
  return dot === -1 ? trackName : trackName.slice(0, dot);
}

function trackProperty(trackName: string): string {
  const dot = trackName.lastIndexOf('.');
  return dot === -1 ? 'unknown' : trackName.slice(dot + 1);
}

/** Infers an approximate FPS from keyframe density. Never claims authored FPS. */
function inferFps(clip: THREE.AnimationClip): number | null {
  if (!clip.tracks.length || !clip.duration || clip.duration <= 0) return null;
  const maxKeys = Math.max(...clip.tracks.map((t) => t.times.length));
  if (maxKeys < 2) return null;
  // Keys-per-second derived from the densest track.
  const keysPerSecond = maxKeys / clip.duration;
  const candidates = [24, 25, 30, 48, 50, 60, 120];
  let best = candidates[0];
  let bestDelta = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - keysPerSecond);
    if (d < bestDelta) {
      bestDelta = d;
      best = c;
    }
  }
  // Only claim an estimate when we are within 15% of a known rate.
  return bestDelta / best <= 0.15 ? best : Math.round(keysPerSecond);
}

export function summarizeClips(
  clips: THREE.AnimationClip[],
  boneNames: Set<string>,
): AnimationClipSummary[] {
  return clips.map((clip) => {
    const props = new Set<string>();
    const unsupported: string[] = [];
    const animated = new Set<string>();

    for (const track of clip.tracks) {
      props.add(trackProperty(track.name));
      const target = trackTargetName(track.name);
      if (boneNames.has(target)) {
        animated.add(target);
      } else {
        unsupported.push(track.name);
      }
    }

    const fps = inferFps(clip);
    return {
      name: clip.name || '(unnamed clip)',
      durationSeconds: Number.isFinite(clip.duration) ? Number(clip.duration.toFixed(4)) : null,
      trackCount: clip.tracks.length,
      trackProperties: [...props].sort(),
      unsupportedTracks: unsupported,
      animatedBones: [...animated].sort(),
      inferredFps: fps,
      fpsBasis: fps === null ? 'not_available' : 'inferred_from_key_density',
    };
  });
}

/**
 * Builds the normalized skeleton from a loaded FBX object graph.
 * Bone order is parent-first so `parentIndex` is always < `index`.
 */
export function buildNormalizedSkeleton(root: THREE.Object3D): NormalizedSkeleton {
  const bones: THREE.Bone[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) bones.push(obj as THREE.Bone);
  });

  // Stable parent-first ordering via DFS from the object roots.
  const ordered: THREE.Bone[] = [];
  const boneSet = new Set<THREE.Bone>(bones);
  const visit = (obj: THREE.Object3D) => {
    if (boneSet.has(obj as THREE.Bone)) ordered.push(obj as THREE.Bone);
    for (const child of obj.children) visit(child);
  };
  visit(root);

  // Any bone not reachable from root (shouldn't happen) is appended.
  for (const b of bones) if (!ordered.includes(b)) ordered.push(b);

  const indexOf = new Map<THREE.Bone, number>();
  ordered.forEach((b, i) => indexOf.set(b, i));

  root.updateMatrixWorld(true);

  const normalized: NormalizedBone[] = ordered.map((bone, index) => {
    let parentBone: THREE.Bone | null = bone.parent as THREE.Bone | null;
    while (parentBone && !boneSet.has(parentBone)) {
      parentBone = parentBone.parent as THREE.Bone | null;
    }
    const parentIndex = parentBone ? indexOf.get(parentBone) ?? null : null;
    // Path is the *bone* chain only (FBXLoader wraps the rig in an unnamed Group,
    // which is not part of the skeleton and must not appear as a bone).
    const path: string[] = [];
    let cursor: THREE.Object3D | null = bone;
    while (cursor && boneSet.has(cursor as THREE.Bone)) {
      path.unshift(cursor.name || '(unnamed)');
      cursor = cursor.parent;
    }
    const world = new THREE.Vector3();
    bone.getWorldPosition(world);

    return {
      name: bone.name,
      index,
      parentIndex,
      parentName: parentBone ? parentBone.name : null,
      path,
      depth: parentIndex === null ? 0 : -1, // filled in below
      restPosition: [bone.position.x, bone.position.y, bone.position.z],
      restQuaternion: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
      restScale: [bone.scale.x, bone.scale.y, bone.scale.z],
      restWorldPosition: [world.x, world.y, world.z],
      childNames: bone.children
        .filter((c) => boneSet.has(c as THREE.Bone))
        .map((c) => c.name),
    };
  });

  // Depth from parent chain (parent-first ordering guarantees availability).
  for (const b of normalized) {
    b.depth = b.parentIndex === null ? 0 : normalized[b.parentIndex].depth + 1;
  }

  const nameCounts = new Map<string, number>();
  for (const b of normalized) nameCounts.set(b.name, (nameCounts.get(b.name) ?? 0) + 1);
  const duplicateBoneNames = [...nameCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();

  const skeleton: NormalizedSkeleton = {
    boneCount: normalized.length,
    bones: normalized,
    rootBoneNames: normalized.filter((b) => b.parentIndex === null).map((b) => b.name),
    leafBoneNames: normalized.filter((b) => b.childNames.length === 0).map((b) => b.name),
    duplicateBoneNames,
    emptyNameCount: normalized.filter((b) => !b.name || !b.name.trim()).length,
    detectedHumanoidSlots: {},
    maxDepth: normalized.reduce((m, b) => Math.max(m, b.depth), 0),
  };

  skeleton.detectedHumanoidSlots = detectHumanoidSlots(skeleton);
  return skeleton;
}

/**
 * Parses raw FBX bytes. Throws on malformed input so the batch runner can record
 * a per-asset failure without aborting the whole run.
 */
export function parseFbxAnimation(
  buffer: ArrayBuffer,
  options: ParseAnimationOptions,
): ParsedAnimationResult {
  const started = Date.now();
  const warnings: string[] = [];

  let root: THREE.Group;
  try {
    // `parseFbx` applies the documented footer-tolerance workaround; see
    // engine/fbxLoaderTolerant.ts. Assets the stock loader already accepts are
    // passed through byte-for-byte unchanged.
    const parsed = parseFbx(buffer, '');
    root = parsed.object as THREE.Group;
    if (parsed.trimmed && parsed.analysis.trailingBytes !== null) {
      warnings.push(
        `FBX footer tolerance applied: trimmed ${parsed.analysis.trimBytes} trailing byte(s) ` +
          `(content ended at ${parsed.analysis.contentEnd}; file has ${parsed.analysis.trailingBytes} ` +
          `footer bytes, three.js budget is ${STOCK_FOOTER_BUDGET}).`,
      );
    }
  } catch (err) {
    return {
      assetId: options.assetId,
      sourcePath: options.sourcePath,
      fileName: options.fileName,
      sha256: options.sha256,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      parseMs: Date.now() - started,
      skeleton: null,
      clips: [],
      durationSeconds: null,
      warnings,
    };
  }

  const skeleton = buildNormalizedSkeleton(root);
  const boneNames = new Set(skeleton.bones.map((b) => b.name));
  const clips = summarizeClips(root.animations ?? [], boneNames);
  const durationSeconds = clips.reduce<number | null>(
    (max, c) => (c.durationSeconds === null ? max : Math.max(max ?? 0, c.durationSeconds)),
    null,
  );

  if (skeleton.boneCount === 0) {
    warnings.push('FBX parsed but contained no bone nodes — no usable skeleton data.');
  }
  if (clips.length === 0) {
    warnings.push('FBX parsed but contained no animation clips.');
  }
  if (skeleton.duplicateBoneNames.length > 0) {
    warnings.push(
      `${skeleton.duplicateBoneNames.length} duplicate bone name(s): ${skeleton.duplicateBoneNames.join(', ')}`,
    );
  }
  for (const clip of clips) {
    if (clip.unsupportedTracks.length > 0) {
      warnings.push(
        `Clip "${clip.name}" has ${clip.unsupportedTracks.length} track(s) that do not target a parsed bone.`,
      );
    }
  }

  const usable = skeleton.boneCount > 0 && clips.length > 0;

  return {
    assetId: options.assetId,
    sourcePath: options.sourcePath,
    fileName: options.fileName,
    sha256: options.sha256,
    status: usable ? 'ok' : 'failed',
    error: usable ? null : 'FBX has no usable skeleton/animation data.',
    parseMs: Date.now() - started,
    skeleton,
    clips,
    durationSeconds: durationSeconds === null ? null : Number(durationSeconds.toFixed(4)),
    warnings,
  };

  // NOTE: `root` is intentionally not disposed — it is garbage-collected once the
  // caller drops the reference. No WebGL resources are created by parsing.
}
