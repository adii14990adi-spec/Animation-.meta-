import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { parseFbxAnimation } from '../src/engine/fbxSkeleton';
import { buildCharacterRigFromGltf } from '../src/engine/characterRig';
import { buildMappings } from '../src/engine/compatibility';
import {
  buildRetargetPlan,
  retargetClip,
  snapshotRestPose,
  restoreRestPose,
  validateRestPosePair,
} from '../src/engine/retarget';
import { readAnimationBuffer, readGltfJson } from './phase2Fixtures';

const MaleGltf = readGltfJson('Male');
const FemaleGltf = readGltfJson('Female');

function loadFbx(fileName: string): THREE.Group {
  return new FBXLoader().parse(readAnimationBuffer(fileName), '');
}

/** Builds a fresh rig + retargeted clip for a character/animation pair. */
function setup(fileName: string, slot: 'male' | 'female', inPlace = true) {
  const rig = buildCharacterRigFromGltf((slot === 'male' ? MaleGltf : FemaleGltf) as never);
  const anim = parseFbxAnimation(readAnimationBuffer(fileName), {
    assetId: fileName,
    sourcePath: `animations/${fileName}`,
    fileName,
    sha256: 'x',
  });
  const { mappings } = buildMappings(anim.skeleton!, rig.skeleton);
  const fbx = loadFbx(fileName);
  const plan = buildRetargetPlan(fbx, rig.root, mappings);
  const result = retargetClip(fbx.animations[0], fbx, rig.root, plan, { inPlace });
  return { rig, anim, mappings, fbx, plan, result };
}

function worldPos(root: THREE.Object3D, boneName: string): THREE.Vector3 {
  let bone: THREE.Bone | null = null;
  root.traverse((o) => {
    if (!bone && (o as THREE.Bone).isBone && o.name === boneName) bone = o as THREE.Bone;
  });
  if (!bone) throw new Error(`bone ${boneName} not found`);
  return (bone as THREE.Bone).getWorldPosition(new THREE.Vector3());
}

/** Vertical distance from hips to a bone, sampled across the clip (unit-free proxy for pose). */
function relativeMotion(
  root: THREE.Object3D,
  hipsName: string,
  boneName: string,
  duration: number,
  mixer: THREE.AnimationMixer,
  samples = 16,
): THREE.Vector3 {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i <= samples; i++) {
    mixer.setTime((i / samples) * duration);
    root.updateMatrixWorld(true);
    const rel = worldPos(root, boneName).sub(worldPos(root, hipsName));
    min.min(rel);
    max.max(rel);
  }
  return max.clone().sub(min);
}

describe('Phase 2 — retargeting onto real characters', () => {
  it('builds a retarget plan with all 32 slots and no dropped bones', () => {
    const { plan } = setup('walk forward.fbx', 'male');
    expect(Object.keys(plan.characterBones).length).toBe(32);
    expect(plan.droppedSlots).toEqual([]);
    expect(plan.hipScale).toBeGreaterThan(0);
  });

  it('derives a dimensionally sane hip scale from the two rigs (cm -> m)', () => {
    const { plan } = setup('walk forward.fbx', 'male');
    // Mixamo hips ≈ 86-105 cm, character hips ≈ 0.95 m => ratio ≈ 0.009-0.011
    expect(plan.hipScale).toBeGreaterThan(0.005);
    expect(plan.hipScale).toBeLessThan(0.02);
  });

  it('produces a non-empty clip with quaternion tracks for the character bones', () => {
    const { result } = setup('walking.fbx', 'male');
    expect(result.clip.tracks.length).toBeGreaterThan(20);
    expect(result.clip.duration).toBeGreaterThan(0);

    const names = result.clip.tracks.map((t) => t.name);
    expect(names).toContain('pelvis.quaternion');
    expect(names).toContain('upperarm_l.quaternion');
    expect(names).toContain('thigh_r.quaternion');
    // Tracks target the CHARACTER bones, never the Mixamo names.
    expect(names.some((n) => n.startsWith('mixamorig'))).toBe(false);
  });

  it('actually animates the character (limbs move, not a frozen pose)', () => {
    const { rig, result } = setup('walk forward.fbx', 'male');
    const mixer = new THREE.AnimationMixer(rig.root);
    mixer.clipAction(result.clip).play();

    const handMotion = relativeMotion(rig.root, 'pelvis', 'hand_l', result.clip.duration, mixer);
    const footMotion = relativeMotion(rig.root, 'pelvis', 'foot_l', result.clip.duration, mixer);

    // A walking clip must move the legs substantially and the arms somewhat.
    expect(footMotion.length()).toBeGreaterThan(0.15);
    expect(handMotion.length()).toBeGreaterThan(0.01);
  });

  it('transfers leg swing faithfully in proportion to the character rig', () => {
    const { rig, result } = setup('walk forward.fbx', 'male');
    const mixer = new THREE.AnimationMixer(rig.root);
    mixer.clipAction(result.clip).play();
    const footRel = relativeMotion(rig.root, 'pelvis', 'foot_l', result.clip.duration, mixer);

    const anim = loadFbx('walk forward.fbx');
    const animMixer = new THREE.AnimationMixer(anim);
    animMixer.clipAction(anim.animations[0]).play();
    const animFootRel = relativeMotion(anim, 'mixamorigHips', 'mixamorigLeftFoot', anim.animations[0].duration, animMixer);

    // Compare in hip-height-normalized units so cm vs m cancels out.
    const restHipY = Math.abs(worldPos(anim, 'mixamorigHips').y) || 1;
    const charHipY = Math.abs(worldPos(rig.root, 'pelvis').y) || 1;
    const animNorm = (animFootRel.z / restHipY) * 100;
    const charNorm = (footRel.z / charHipY) * 100;
    const ratio = charNorm / animNorm;

    // Motion magnitude must be preserved (not damped, not exploded).
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });

  it('retargets onto the Female character as well as the Male', () => {
    for (const slot of ['male', 'female'] as const) {
      const { rig, result } = setup('run forward.fbx', slot);
      expect(result.usedSlots.length).toBeGreaterThan(20);
      const mixer = new THREE.AnimationMixer(rig.root);
      mixer.clipAction(result.clip).play();
      const motion = relativeMotion(rig.root, 'pelvis', 'calf_l', result.clip.duration, mixer);
      expect(motion.length(), slot).toBeGreaterThan(0.05);
    }
  });

  it('keeps the character in place when in-place mode is on', () => {
    const { rig, result } = setup('walk forward.fbx', 'male', true);
    const mixer = new THREE.AnimationMixer(rig.root);
    mixer.clipAction(result.clip).play();

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i <= 16; i++) {
      mixer.setTime((i / 16) * result.clip.duration);
      rig.root.updateMatrixWorld(true);
      const hips = worldPos(rig.root, 'pelvis');
      minX = Math.min(minX, hips.x); maxX = Math.max(maxX, hips.x);
      minZ = Math.min(minZ, hips.z); maxZ = Math.max(maxZ, hips.z);
    }
    // Horizontal hip drift is removed (vertical bob is preserved).
    expect(maxX - minX).toBeLessThan(0.02);
    expect(maxZ - minZ).toBeLessThan(0.02);
    expect(result.inPlace).toBe(true);
    expect(result.notes.join(' ')).toMatch(/in-place/i);
  });

  it('does not invert or collapse limbs: bone-to-bone distances stay near the rest pose', () => {
    const { rig, result } = setup('walk forward.fbx', 'male');
    const restA = worldPos(rig.root, 'upperarm_l').distanceTo(worldPos(rig.root, 'lowerarm_l'));
    const restB = worldPos(rig.root, 'lowerarm_l').distanceTo(worldPos(rig.root, 'hand_l'));

    const mixer = new THREE.AnimationMixer(rig.root);
    mixer.clipAction(result.clip).play();
    for (let i = 0; i <= 12; i++) {
      mixer.setTime((i / 12) * result.clip.duration);
      rig.root.updateMatrixWorld(true);
      const a = worldPos(rig.root, 'upperarm_l').distanceTo(worldPos(rig.root, 'lowerarm_l'));
      const b = worldPos(rig.root, 'lowerarm_l').distanceTo(worldPos(rig.root, 'hand_l'));
      // Rotations only — segment lengths must be preserved exactly.
      expect(a).toBeCloseTo(restA, 4);
      expect(b).toBeCloseTo(restB, 4);
    }
  });

  it('restores the exact bind pose after previewing', () => {
    const { rig, result } = setup('walk forward.fbx', 'male');
    const snapshot = snapshotRestPose(rig.root);
    const before = worldPos(rig.root, 'hand_l').clone();

    const mixer = new THREE.AnimationMixer(rig.root);
    mixer.clipAction(result.clip).play();
    mixer.setTime(result.clip.duration * 0.4);
    rig.root.updateMatrixWorld(true);
    expect(worldPos(rig.root, 'hand_l').distanceTo(before)).toBeGreaterThan(0.0005);

    restoreRestPose(rig.root, snapshot);
    expect(worldPos(rig.root, 'hand_l').distanceTo(before)).toBeLessThan(1e-9);
  });

  it('flags an implausible rest-pose pair instead of silently inverting a limb', () => {
    const a = new THREE.Quaternion();
    // Identical rest orientations are always acceptable.
    expect(validateRestPosePair(a, a).ok).toBe(true);

    // A 90° convention difference is acceptable.
    const quarter = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    expect(validateRestPosePair(a, quarter).ok).toBe(true);
    expect(validateRestPosePair(a, quarter).angleDeg).toBeCloseTo(90, 3);

    // A ~180° flip exceeds the default 150° threshold and is reported as a
    // divergence instead of being silently accepted as a rotation transfer.
    const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    const flipResult = validateRestPosePair(a, flip);
    expect(flipResult.ok).toBe(false);
    expect(flipResult.angleDeg).toBeCloseTo(180, 1);

    // The measured angle is always reported, even when the pair is rejected.
    expect(validateRestPosePair(a, flip, 200).ok).toBe(true);
  });

  it('caps sampled frames so long clips cannot exhaust memory', () => {
    const { result } = setup('Grab And Put Back Rifle.fbx', 'male');
    expect(result.sampledFrames).toBeLessThanOrEqual(1200);
    expect(result.fps).toBeGreaterThanOrEqual(12);
    expect(result.fps).toBeLessThanOrEqual(60);
  });

  it('does not mutate the character geometry or the source FBX transforms', () => {
    const rig = buildCharacterRigFromGltf(MaleGltf as never);
    const before = rig.skeleton.bones.map((b) => [...b.restQuaternion]).flat();
    const fbx = loadFbx('walk forward.fbx');
    const origTracks = fbx.animations[0].tracks.length;
    const anim = parseFbxAnimation(readAnimationBuffer('walk forward.fbx'), {
      assetId: 'a', sourcePath: 'animations/walk forward.fbx', fileName: 'walk forward.fbx', sha256: 'x',
    });
    const { mappings } = buildMappings(anim.skeleton!, rig.skeleton);
    const plan = buildRetargetPlan(fbx, rig.root, mappings);
    retargetClip(fbx.animations[0], fbx, rig.root, plan, { inPlace: true });

    // Rest data rebuilt from the same glTF is unchanged.
    const after = buildCharacterRigFromGltf(MaleGltf as never);
    expect(after.skeleton.bones.map((b) => [...b.restQuaternion]).flat()).toEqual(before);
    // Source clip untouched.
    expect(fbx.animations[0].tracks.length).toBe(origTracks);
  });

  it('preserves hand height and hips-relative reach (world-space delta transfer)', () => {
    // Regression guard for the transfer formulation. Transferring the bind-pose
    // delta in the BONE's local frame (C = C0 * A0^-1 * A) bakes the source bone's
    // arbitrary rest orientation into the rotation, and because the Mixamo and
    // Unreal rigs disagree by ~84 deg on the upper arm and ~180 deg on the thigh,
    // that form folded the arms across the chest and lifted the hands to face
    // height (~1.5 m). The world-space form (C = A * A0^-1 * C0) keeps the hands
    // at a natural carry height and close to the source's own hips-relative reach.
    const { result, rig } = setup('walk forward.fbx', 'male');
    const hipsRestHeight = worldPos(rig.root, 'pelvis').y;
    const mixer = new THREE.AnimationMixer(rig.root);
    mixer.clipAction(result.clip).play();

    const samples = 16;
    const reachErrors: number[] = [];
    for (let i = 0; i <= samples; i++) {
      mixer.setTime((i / samples) * result.clip.duration);
      rig.root.updateMatrixWorld(true);
      const hips = worldPos(rig.root, 'pelvis');
      const hand = worldPos(rig.root, 'hand_l');
      // Hands must stay below shoulder height and in front of / beside the body,
      // never folded up to the face.
      expect(hand.y).toBeLessThan(hipsRestHeight + 0.45);
      expect(hand.y).toBeGreaterThan(hipsRestHeight - 0.35);
      reachErrors.push(hand.distanceTo(hips));
    }

    // Reach must stay within the character's own arm span: a collapsed or
    // over-rotated transfer stretches the shoulder-to-hand distance. The reach is
    // stable across the clip (no popping / stretching artefacts).
    const restReach = worldPos(rig.root, 'hand_l').distanceTo(worldPos(rig.root, 'pelvis'));
    const mean = reachErrors.reduce((a, b) => a + b, 0) / reachErrors.length;
    const spread = Math.max(...reachErrors) - Math.min(...reachErrors);
    expect(mean).toBeGreaterThan(0.3);
    expect(mean).toBeLessThan(restReach * 1.05);
    expect(spread).toBeLessThan(0.05);

    // The hand must also be visibly in FRONT of the body (positive Z is forward for
    // this character), which is the axis the broken local-frame form flipped.
    mixer.setTime(0);
    rig.root.updateMatrixWorld(true);
    expect(worldPos(rig.root, 'hand_l').z).toBeGreaterThan(0);
  });

  it('drives limb positions from the source pose rather than reusing the bind pose', () => {
    // The earlier ordering bug sampled the animation's "rest" pose AFTER calling
    // mixer.update(0), which made every delta relative to frame 0 and collapsed
    // the clip to a near-static pose. A real walk must move both feet through a
    // large horizontal range relative to the hips.
    const { result, rig } = setup('walk forward.fbx', 'male');
    const mixer = new THREE.AnimationMixer(rig.root);
    mixer.clipAction(result.clip).play();

    const zs: number[] = [];
    for (let i = 0; i <= 16; i++) {
      mixer.setTime((i / 16) * result.clip.duration);
      rig.root.updateMatrixWorld(true);
      zs.push(worldPos(rig.root, 'foot_l').z);
    }
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.4);
  });
});
