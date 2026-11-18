import { describe, expect, it } from 'vitest';
import { parseFbxAnimation } from '../src/engine/fbxSkeleton';
import {
  SLOT_DEFINITIONS,
  SLOT_ORDER,
  matchHumanoidSlots,
  normalizeBoneName,
} from '../src/engine/humanoidRegistry';
import {
  animationFileNames,
  malformedFbxBuffer,
  readAnimationBuffer,
  syntheticSkeleton,
  truncatedFbxBuffer,
} from './phase2Fixtures';
import { buildNormalizedSkeleton } from '../src/engine/fbxSkeleton';

function parse(fileName: string) {
  return parseFbxAnimation(readAnimationBuffer(fileName), {
    assetId: `animations/${fileName}`,
    sourcePath: `animations/${fileName}`,
    fileName,
    sha256: 'test',
  });
}

describe('Phase 2 — FBX skeleton extraction (real assets)', () => {
  it('extracts a 65-bone Mixamo hierarchy from a real animation', () => {
    const result = parse('idle.fbx');
    expect(result.status).toBe('ok');
    const skeleton = result.skeleton!;

    expect(skeleton.boneCount).toBe(65);
    expect(skeleton.rootBoneNames).toEqual(['mixamorigHips']);
    expect(skeleton.duplicateBoneNames).toEqual([]);
    expect(skeleton.emptyNameCount).toBe(0);
    expect(skeleton.maxDepth).toBeGreaterThan(4);

    const hips = skeleton.bones.find((b) => b.name === 'mixamorigHips')!;
    expect(hips.parentIndex).toBeNull();
    expect(hips.depth).toBe(0);

    const head = skeleton.bones.find((b) => b.name === 'mixamorigHead')!;
    expect(head.parentName).toBe('mixamorigNeck');
    // Path is the bone chain only — the FBX loader's unnamed wrapper is excluded.
    expect(head.path[0]).toBe('mixamorigHips');
    expect(head.path[head.path.length - 1]).toBe('mixamorigHead');
    expect(head.path).not.toContain('(unnamed)');
  });

  it('records parent-child relationships for every non-root bone', () => {
    const skeleton = parse('walking.fbx').skeleton!;
    for (const bone of skeleton.bones) {
      if (bone.parentIndex === null) continue;
      const parent = skeleton.bones[bone.parentIndex];
      expect(bone.parentName).toBe(parent.name);
      expect(parent.childNames).toContain(bone.name);
      expect(bone.depth).toBe(parent.depth + 1);
    }
  });

  it('extracts animation clips with tracks, duration and animated bones', () => {
    const result = parse('walk forward.fbx');
    expect(result.clips.length).toBe(1);
    const clip = result.clips[0];

    expect(clip.trackCount).toBe(53);
    expect(clip.durationSeconds).toBeGreaterThan(0);
    expect(clip.trackProperties).toContain('quaternion');
    expect(clip.trackProperties).toContain('position');
    expect(clip.animatedBones.length).toBeGreaterThan(40);
    expect(clip.unsupportedTracks).toEqual([]);
    expect(result.durationSeconds).toBeGreaterThan(0);
  });

  it('never claims a verified authored FPS — only an inferred estimate', () => {
    const clip = parse('idle.fbx').clips[0];
    expect(clip.fpsBasis).toBe('inferred_from_key_density');
    expect(clip.inferredFps).toBeGreaterThan(0);
    // The type only permits the two honest bases.
    expect(['not_available', 'inferred_from_key_density']).toContain(clip.fpsBasis);
  });

  it('detects the humanoid slots present in a Mixamo animation', () => {
    const skeleton = parse('run forward.fbx').skeleton!;
    const slots = skeleton.detectedHumanoidSlots;

    expect(slots.hips).toBe('mixamorigHips');
    expect(slots.head).toBe('mixamorigHead');
    expect(slots.leftUpperArm).toBe('mixamorigLeftArm');
    expect(slots.rightUpperArm).toBe('mixamorigRightArm');
    expect(slots.leftUpperLeg).toBe('mixamorigLeftUpLeg');
    expect(slots.rightFoot).toBe('mixamorigRightFoot');
    expect(slots.leftToe).toBe('mixamorigLeftToeBase');
    expect(slots.leftThumb).toBe('mixamorigLeftHandThumb1');
  });

  it('parses every real animation successfully (74/74, no footer casualties)', () => {
    // History: this test previously expected 72 ok / 2 failed, based on the belief
    // that `death from the back.fbx` and `reloading.fbx` were malformed. They are
    // not — they are valid files whose footer is 177 bytes instead of the 176 that
    // three.js's endOfContent() hardcodes. See engine/fbxLoaderTolerant.ts.
    const names = animationFileNames();
    expect(names.length).toBe(74);

    const results = names.map((n) => parse(n));
    const ok = results.filter((r) => r.status === 'ok');
    const failed = results.filter((r) => r.status !== 'ok');

    expect(failed.map((f) => `${f.fileName}: ${f.error ?? ''}`)).toEqual([]);
    expect(ok.length).toBe(74);

    // The two formerly-rejected assets now produce real skeletons and clips.
    for (const file of ['death from the back.fbx', 'reloading.fbx']) {
      const r = results.find((x) => x.fileName === file)!;
      expect(r.status).toBe('ok');
      expect(r.skeleton!.boneCount).toBe(65);
      expect(r.clips.length).toBe(1);
      expect(r.warnings.some((w) => /footer tolerance applied/i.test(w))).toBe(true);
    }
    // Every parsed animation has exactly one clip and 65 bones.
    for (const r of ok) {
      expect(r.skeleton!.boneCount).toBe(65);
      expect(r.clips.length).toBe(1);
    }
  });
});

describe('Phase 2 — malformed FBX handling', () => {
  it('fails gracefully on non-FBX bytes instead of throwing', () => {
    const result = parseFbxAnimation(malformedFbxBuffer(), {
      assetId: 'x', sourcePath: 'animations/bad.fbx', fileName: 'bad.fbx', sha256: 'h',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(result.skeleton).toBeNull();
    expect(result.clips).toEqual([]);
  });

  it('fails gracefully on a truncated FBX header', () => {
    const result = parseFbxAnimation(truncatedFbxBuffer(), {
      assetId: 'y', sourcePath: 'animations/truncated.fbx', fileName: 'truncated.fbx', sha256: 'h',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });
});

describe('Phase 2 — bone alias matching and side safety', () => {
  it('normalizes Mixamo, Unreal and generic naming styles', () => {
    expect(normalizeBoneName('mixamorigLeftArm')).toBe('leftarm');
    expect(normalizeBoneName('upperarm_l')).toBe('upperarml');
    expect(normalizeBoneName('Left Arm')).toBe('leftarm');
    expect(normalizeBoneName('Bip01_L_UpperArm')).toBe('lupperarm');
    expect(normalizeBoneName('CTRL:Head')).toBe('head');
  });

  it('maps a Mixamo rig to all required humanoid slots', () => {
    const matches = matchHumanoidSlots(parse('idle.fbx').skeleton!);
    const required = SLOT_ORDER.filter((s) => SLOT_DEFINITIONS[s].required);
    const missing = required.filter((s) => !matches[s].bone);
    expect(missing).toEqual([]);
  });

  it('maps an Unreal Mannequin rig to all 32 slots including hips', () => {
    const root = syntheticSkeleton([
      { name: 'root', parent: null },
      { name: 'pelvis', parent: 'root' },
      { name: 'spine_01', parent: 'pelvis' },
      { name: 'spine_02', parent: 'spine_01' },
      { name: 'spine_03', parent: 'spine_02' },
      { name: 'neck_01', parent: 'spine_03' },
      { name: 'Head', parent: 'neck_01' },
      { name: 'clavicle_l', parent: 'spine_03' },
      { name: 'upperarm_l', parent: 'clavicle_l' },
      { name: 'lowerarm_l', parent: 'upperarm_l' },
      { name: 'hand_l', parent: 'lowerarm_l' },
      { name: 'clavicle_r', parent: 'spine_03' },
      { name: 'upperarm_r', parent: 'clavicle_r' },
      { name: 'lowerarm_r', parent: 'upperarm_r' },
      { name: 'hand_r', parent: 'lowerarm_r' },
      { name: 'thigh_l', parent: 'pelvis' },
      { name: 'calf_l', parent: 'thigh_l' },
      { name: 'foot_l', parent: 'calf_l' },
      { name: 'ball_l', parent: 'foot_l' },
      { name: 'thigh_r', parent: 'pelvis' },
      { name: 'calf_r', parent: 'thigh_r' },
      { name: 'foot_r', parent: 'calf_r' },
      { name: 'ball_r', parent: 'foot_r' },
    ]);
    const skeleton = buildNormalizedSkeleton(root);
    const matches = matchHumanoidSlots(skeleton);

    // `root` must never steal the hips slot from `pelvis`.
    expect(matches.hips.bone).toBe('pelvis');
    expect(matches.spine.bone).toBe('spine_01');
    expect(matches.chest.bone).toBe('spine_02');
    expect(matches.upperChest.bone).toBe('spine_03');
    expect(matches.head.bone).toBe('Head');
    expect(matches.leftUpperArm.bone).toBe('upperarm_l');
    expect(matches.rightLowerLeg.bone).toBe('calf_r');
    expect(matches.leftToe.bone).toBe('ball_l');
    for (const slot of SLOT_ORDER.filter((s) => SLOT_DEFINITIONS[s].required)) {
      expect(matches[slot].bone, `required slot ${slot}`).toBeTruthy();
    }
  });

  it('never maps a left-side slot to a right-side bone', () => {
    const root = syntheticSkeleton([
      { name: 'Hips', parent: null },
      { name: 'Spine', parent: 'Hips' },
      { name: 'LeftArm', parent: 'Spine' },
      { name: 'RightArm', parent: 'Spine' },
      { name: 'LeftHand', parent: 'LeftArm' },
      { name: 'RightHand', parent: 'RightArm' },
    ]);
    const matches = matchHumanoidSlots(buildNormalizedSkeleton(root));

    expect(matches.leftUpperArm.bone).toBe('LeftArm');
    expect(matches.rightUpperArm.bone).toBe('RightArm');
    expect(matches.leftHand.bone).toBe('LeftHand');
    expect(matches.rightHand.bone).toBe('RightHand');
    // No cross-side leakage in either direction.
    expect(matches.leftUpperArm.bone).not.toMatch(/right/i);
    expect(matches.rightHand.bone).not.toMatch(/left/i);
  });

  it('rejects an opposite-side-only rig rather than guessing', () => {
    const root = syntheticSkeleton([
      { name: 'Hips', parent: null },
      { name: 'Spine', parent: 'Hips' },
      { name: 'RightArm', parent: 'Spine' },
    ]);
    const matches = matchHumanoidSlots(buildNormalizedSkeleton(root));
    expect(matches.leftUpperArm.bone).toBeNull();
    expect(matches.rightUpperArm.bone).toBe('RightArm');
  });

  it('detects duplicate bone names', () => {
    const root = syntheticSkeleton([
      { name: 'Hips', parent: null },
      { name: 'Spine', parent: 'Hips' },
      { name: 'Spine', parent: 'Hips' },
    ]);
    const skeleton = buildNormalizedSkeleton(root);
    expect(skeleton.duplicateBoneNames).toContain('Spine');
  });

  it('never assigns one bone to two different slots', () => {
    const matches = matchHumanoidSlots(parse('idle.fbx').skeleton!);
    const assigned = SLOT_ORDER.map((s) => matches[s].bone).filter((b): b is string => Boolean(b));
    expect(new Set(assigned).size).toBe(assigned.length);
  });
});
