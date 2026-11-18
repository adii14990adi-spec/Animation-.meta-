/**
 * Phase 2 orchestration: discovery -> parse -> map -> score for both characters.
 *
 * This module is deliberately free of React so it can be driven identically from
 * the UI, from tests and from a headless browser verification script.
 */

import type {
  AnimationAnalysisBundle,
  AnimationAssetEntry,
  AnimationDiscoveryReport,
  BoneMappingProfile,
  CompatibilityReport,
  ParsedAnimationResult,
} from './animationTypes';
import { analyzeCompatibility, buildMappings } from './compatibility';
import { buildAnalysisBundle } from './animationReports';
import { parseAnimationBatch, type BatchProgress } from './animationLibrary';
import type { CharacterRig } from './characterRig';

export interface Phase2RunOptions {
  discovery: AnimationDiscoveryReport;
  buffers: Map<string, ArrayBuffer>;
  maleRig: CharacterRig;
  femaleRig: CharacterRig;
  cache?: Map<string, ParsedAnimationResult>;
  only?: string[];
  useWorker?: boolean;
  onProgress?: (progress: BatchProgress) => void;
  onResult?: (result: ParsedAnimationResult) => void;
}

export interface Phase2RunResult {
  bundle: AnimationAnalysisBundle;
  cache: Map<string, ParsedAnimationResult>;
  ok: number;
  failed: number;
  cachedHits: number;
  workerUsed: boolean;
  elapsedMs: number;
}

function characterSignature(rig: CharacterRig, slot: 'male' | 'female'): string {
  const names = rig.skeleton.bones.map((b) => b.name).join('|');
  return `${slot}:${rig.skeleton.boneCount}:${names.length}:${hashString(names)}`;
}

function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function buildMappingProfiles(
  animations: ParsedAnimationResult[],
  maleRig: CharacterRig,
  femaleRig: CharacterRig,
): BoneMappingProfile[] {
  const profiles: BoneMappingProfile[] = [];
  const createdAtIso = new Date().toISOString();

  for (const anim of animations) {
    if (!anim.skeleton) continue;
    const animSignature = `anim:${anim.skeleton.boneCount}:${hashString(anim.skeleton.bones.map((b) => b.name).join('|'))}`;

    for (const [slot, rig] of [
      ['male', maleRig],
      ['female', femaleRig],
    ] as const) {
      const { mappings } = buildMappings(anim.skeleton, rig.skeleton);
      profiles.push({
        id: `${anim.assetId}::${slot}`,
        animationSignature: animSignature,
        characterSignature: characterSignature(rig, slot),
        createdAtIso,
        entries: mappings,
        ambiguousSlots: mappings.filter((m) => !m.animationBone && m.notes.some((n) => /Ambiguous/.test(n))).map((m) => m.slot),
        manuallyAdjusted: false,
      });
    }
  }

  return profiles;
}

/** Runs parse + compatibility for every animation against both characters. */
export async function runPhase2(options: Phase2RunOptions): Promise<Phase2RunResult> {
  const started = Date.now();

  const batch = await parseAnimationBatch({
    assets: options.discovery.assets,
    buffers: options.buffers,
    cache: options.cache,
    useWorker: options.useWorker,
    only: options.only,
    onProgress: options.onProgress,
    onResult: options.onResult,
  });

  const animations = batch.results;

  // Score every parsed animation against both characters.
  const compatibility: CompatibilityReport[] = [];
  for (const anim of animations) {
    if (!anim.skeleton) continue;
    compatibility.push(
      analyzeCompatibility({ animation: anim, characterSlot: 'male', characterSkeleton: options.maleRig.skeleton }),
    );
    compatibility.push(
      analyzeCompatibility({ animation: anim, characterSlot: 'female', characterSkeleton: options.femaleRig.skeleton }),
    );
    options.onProgress?.({
      phase: 'analyzing',
      done: compatibility.length,
      total: animations.length * 2,
      current: anim.fileName,
      ok: batch.ok,
      failed: batch.failed,
    });
  }

  // Animations that failed to parse still get a PROCESSING_FAILED report per character.
  for (const anim of animations.filter((a) => a.status !== 'ok')) {
    for (const slot of ['male', 'female'] as const) {
      compatibility.push(
        analyzeCompatibility({
          animation: anim,
          characterSlot: slot,
          characterSkeleton: (slot === 'male' ? options.maleRig : options.femaleRig).skeleton,
        }),
      );
    }
  }

  const mappings = buildMappingProfiles(animations, options.maleRig, options.femaleRig);

  const bundle = buildAnalysisBundle({
    discovery: options.discovery,
    animations,
    compatibility,
    mappings,
    characterSignatures: {
      male: characterSignature(options.maleRig, 'male'),
      female: characterSignature(options.femaleRig, 'female'),
    },
  });

  options.onProgress?.({
    phase: 'done',
    done: options.discovery.assets.length,
    total: options.discovery.assets.length,
    current: '',
    ok: batch.ok,
    failed: batch.failed,
  });

  return {
    bundle,
    cache: batch.cache,
    ok: batch.ok,
    failed: batch.failed,
    cachedHits: batch.cachedHits,
    workerUsed: batch.workerUsed,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Automatically selects the single best animation for the first end-to-end test:
 * prefer an Idle, then a Walk, favouring assets with the highest required-slot
 * coverage and the shortest filename (so "idle.fbx" beats "idle crouching aiming.fbx").
 */
export function selectFirstTestAnimation(
  assets: AnimationAssetEntry[],
  compatibility: CompatibilityReport[],
): AnimationAssetEntry | null {
  if (assets.length === 0) return null;
  const score = (asset: AnimationAssetEntry): number => {
    const male = compatibility.find((c) => c.assetId === asset.id && c.characterSlot === 'male');
    const female = compatibility.find((c) => c.assetId === asset.id && c.characterSlot === 'female');
    const coverage = (male?.scoring.requiredSlotCoverage ?? 0) + (female?.scoring.requiredSlotCoverage ?? 0);
    const categoryBonus = asset.category === 'Idle' ? 100 : asset.category === 'Walk' ? 60 : 0;
    const namePenalty = asset.fileName.length;
    return categoryBonus + coverage * 10 - namePenalty;
  };

  return [...assets].sort((a, b) => score(b) - score(a) || a.fileName.localeCompare(b.fileName))[0];
}
