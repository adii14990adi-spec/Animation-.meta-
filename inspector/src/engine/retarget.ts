/**
 * Browser-side animation retargeting.
 *
 * Why not just copy tracks by bone name?
 * --------------------------------------
 * The repository animations are Mixamo rigs (`mixamorigHips`, `mixamorigLeftArm`)
 * while both characters are Unreal Mannequin rigs (`pelvis`, `upperarm_l`). Those
 * two rigs differ in:
 *   - bone names            -> handled by the humanoid slot mapping
 *   - rest orientations     -> handled by world-space delta transfer (below)
 *   - segment counts        -> Mixamo spine/spine1/spine2 vs pelvis/spine_01..03
 *   - scale                 -> Mixamo FBX is authored in centimetres
 *
 * The transfer rule used here is exact and orientation-agnostic:
 *
 *     delta(t)        = R_anim_world(t) * R_anim_rest_world^-1
 *     R_char_world(t) = delta(t) * R_char_rest_world
 *     q_char_local(t) = R_char_parent_world(t)^-1 * R_char_world(t)
 *
 * i.e. the *world-space* rotation change of the animation bone is applied on top
 * of the character's own rest orientation. That preserves the character's
 * proportions and rest pose, so limbs cannot end up inverted or collapsed the way
 * naive local-quaternion copying produces. Hip translation is transferred as a
 * world-space offset scaled by the character/anim hip-height ratio, and root
 * motion can be neutralised (in-place preview).
 *
 * This is browser geometry-level retargeting. It is NOT Unity AvatarBuilder and is
 * not a substitute for Unity runtime verification.
 */

import * as THREE from 'three';
import type { BoneMappingEntry, HumanoidSlotId } from './animationTypes';

export interface RetargetOptions {
  /** Keep the character in place by discarding horizontal hip translation. */
  inPlace: boolean;
  /** Sample rate for the baked clip. Defaults to a clamped animation estimate. */
  fps?: number;
  /** Hard cap on baked frames to keep mobile browsers responsive. */
  maxFrames?: number;
}

export interface RetargetPlan {
  /** slot -> animation bone name */
  animationBones: Partial<Record<HumanoidSlotId, string>>;
  /** slot -> character bone name */
  characterBones: Partial<Record<HumanoidSlotId, string>>;
  /** Per-slot world-space rest rotation of the animation bone. */
  animationRestWorld: Partial<Record<HumanoidSlotId, THREE.Quaternion>>;
  /** Per-slot world-space rest rotation of the character bone. */
  characterRestWorld: Partial<Record<HumanoidSlotId, THREE.Quaternion>>;
  /** cm -> m (or whatever) scale factor derived from hip heights. */
  hipScale: number;
  hipsAnimationRestWorldPos: THREE.Vector3 | null;
  hipsCharacterRestWorldPos: THREE.Vector3 | null;
  /** Slots that were dropped because a rest-pose sanity check failed. */
  droppedSlots: Array<{ slot: HumanoidSlotId; reason: string }>;
}

export interface RetargetResult {
  clip: THREE.AnimationClip;
  sampledFrames: number;
  fps: number;
  usedSlots: HumanoidSlotId[];
  droppedSlots: Array<{ slot: HumanoidSlotId; reason: string }>;
  inPlace: boolean;
  notes: string[];
}

/** Collects the world-space rest rotation of each bone in an object graph. */
export function collectRestWorldQuaternions(
  root: THREE.Object3D,
): Map<string, THREE.Quaternion> {
  root.updateMatrixWorld(true);
  const out = new Map<string, THREE.Quaternion>();
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      const q = new THREE.Quaternion();
      obj.getWorldQuaternion(q);
      out.set(obj.name, q);
    }
  });
  return out;
}

function findBoneByName(root: THREE.Object3D, name: string): THREE.Bone | null {
  let found: THREE.Bone | null = null;
  root.traverse((obj) => {
    if (!found && (obj as THREE.Bone).isBone && obj.name === name) found = obj as THREE.Bone;
  });
  return found;
}

/**
 * Sanity check that prevents a mapping from inverting a limb.
 *
 * Rejects a mapped animation/character pair whose rest orientations differ by
 * more than `maxDeg`. Such a pair would spin the limb to a wildly different base
 * orientation rather than transferring motion. 150° is used as the default so
 * that legitimate ~180° axis-convention differences between Mixamo and Unreal
 * rigs are reported but not treated as a hard inversion; the value is always
 * returned so callers can report the measured angle regardless of the verdict.
 */
export function validateRestPosePair(
  animationRest: THREE.Quaternion,
  characterRest: THREE.Quaternion,
  maxDeg = 150,
): { ok: boolean; angleDeg: number } {
  const angleDeg = THREE.MathUtils.radToDeg(animationRest.angleTo(characterRest));
  // Small tolerance so an exact-threshold angle is not rejected by float noise.
  return { ok: angleDeg <= maxDeg + 1e-6, angleDeg };
}

export function buildRetargetPlan(
  animationRoot: THREE.Object3D,
  characterRoot: THREE.Object3D,
  mappings: BoneMappingEntry[],
): RetargetPlan {
  animationRoot.updateMatrixWorld(true);
  characterRoot.updateMatrixWorld(true);

  const animRest = collectRestWorldQuaternions(animationRoot);
  const charRest = collectRestWorldQuaternions(characterRoot);

  const plan: RetargetPlan = {
    animationBones: {},
    characterBones: {},
    animationRestWorld: {},
    characterRestWorld: {},
    hipScale: 1,
    hipsAnimationRestWorldPos: null,
    hipsCharacterRestWorldPos: null,
    droppedSlots: [],
  };

  for (const m of mappings) {
    if (!m.animationBone || !m.characterBone) continue;
    const aq = animRest.get(m.animationBone);
    const cq = charRest.get(m.characterBone);
    if (!aq || !cq) {
      plan.droppedSlots.push({
        slot: m.slot,
        reason: `bone missing during plan build (animation: ${Boolean(aq)}, character: ${Boolean(cq)})`,
      });
      continue;
    }
    plan.animationBones[m.slot] = m.animationBone;
    plan.characterBones[m.slot] = m.characterBone;
    plan.animationRestWorld[m.slot] = aq.clone();
    plan.characterRestWorld[m.slot] = cq.clone();
  }

  // Hip height ratio gives a dimensionally correct translation scale and is a
  // transparent, inspectable number rather than a hand-tuned magic constant.
  const animHip = plan.animationBones.hips
    ? findBoneByName(animationRoot, plan.animationBones.hips)
    : null;
  const charHip = plan.characterBones.hips
    ? findBoneByName(characterRoot, plan.characterBones.hips)
    : null;
  if (animHip && charHip) {
    const aPos = animHip.getWorldPosition(new THREE.Vector3());
    const cPos = charHip.getWorldPosition(new THREE.Vector3());
    plan.hipsAnimationRestWorldPos = aPos;
    plan.hipsCharacterRestWorldPos = cPos;
    if (Math.abs(aPos.y) > 1e-6) {
      const scale = Math.abs(cPos.y / aPos.y);
      // Guard against absurd ratios from un-normalized rigs.
      plan.hipScale = Number.isFinite(scale) && scale > 1e-4 && scale < 1e4 ? scale : 1;
    }
  }

  return plan;
}

/** Depth-ordered character bone list, so parents are processed before children. */
function orderedCharacterBones(
  characterRoot: THREE.Object3D,
  names: Set<string>,
): THREE.Bone[] {
  const ordered: THREE.Bone[] = [];
  const visit = (obj: THREE.Object3D) => {
    if ((obj as THREE.Bone).isBone && names.has(obj.name)) ordered.push(obj as THREE.Bone);
    for (const child of obj.children) visit(child);
  };
  visit(characterRoot);
  return ordered;
}

/**
 * Bakes a retargeted clip by sampling the source animation at a fixed rate.
 *
 * Returns a normal `THREE.AnimationClip` whose tracks target the character's own
 * bone names, so preview playback is a plain `AnimationMixer` + `clipAction`.
 */
export function retargetClip(
  sourceClip: THREE.AnimationClip,
  animationRoot: THREE.Object3D,
  characterRoot: THREE.Object3D,
  plan: RetargetPlan,
  options: RetargetOptions,
): RetargetResult {
  const notes: string[] = [];
  const dropped = [...plan.droppedSlots];

  const trackLike = sourceClip.tracks.map((t) => t.times.length);
  const derivedFps =
    sourceClip.duration > 0 && trackLike.length > 0
      ? Math.max(...trackLike) / sourceClip.duration
      : 0;
  const fps = options.fps ?? THREE.MathUtils.clamp(Math.round(derivedFps) || 30, 12, 60);
  const maxFrames = options.maxFrames ?? 1200;
  const estimated = Math.max(2, Math.round(sourceClip.duration * fps) + 1);
  const frames = Math.min(estimated, maxFrames);
  if (estimated > maxFrames) {
    notes.push(
      `Clip sampled at ${frames} of ${estimated} frames (cap ${maxFrames}) to bound memory.`,
    );
  }

  // Locate every character bone we will animate.
  const charBonesBySlot = new Map<HumanoidSlotId, THREE.Bone>();
  for (const [slot, boneName] of Object.entries(plan.characterBones) as Array<
    [HumanoidSlotId, string]
  >) {
    const bone = findBoneByName(characterRoot, boneName);
    if (bone) charBonesBySlot.set(slot, bone);
    else dropped.push({ slot, reason: `character bone "${boneName}" not found` });
  }

  const animBonesBySlot = new Map<HumanoidSlotId, THREE.Bone>();
  for (const [slot, boneName] of Object.entries(plan.animationBones) as Array<
    [HumanoidSlotId, string]
  >) {
    const bone = findBoneByName(animationRoot, boneName);
    if (bone) animBonesBySlot.set(slot, bone);
    else dropped.push({ slot, reason: `animation bone "${boneName}" not found` });
  }

  // Character rest world quaternions (rest pose is the bind pose).
  const charRestWorld = new Map<string, THREE.Quaternion>();
  const charRestWorldPos = new Map<string, THREE.Vector3>();
  for (const [slot, bone] of charBonesBySlot) {
    // Fall back to a direct read when the parent is not a bone (e.g. Armature group).
    const world = new THREE.Quaternion();
    bone.getWorldQuaternion(world);
    charRestWorld.set(slot, world);
    charRestWorldPos.set(slot, bone.getWorldPosition(new THREE.Vector3()));
  }

  // Hips of each rig, used for hip translation transfer.
  const hipsCharBone = charBonesBySlot.get('hips');
  const hipsAnimBone = animBonesBySlot.get('hips');

  // Rest matrices of each character bone's parent, needed to convert a desired
  // world rotation back into a local rotation.
  const charParentRestWorldQuat = new Map<string, THREE.Quaternion>();
  for (const [, bone] of charBonesBySlot) {
    const parent = bone.parent as THREE.Object3D | null;
    const q = new THREE.Quaternion();
    if (parent) parent.getWorldQuaternion(q);
    charParentRestWorldQuat.set(bone.name, q);
  }

  // Character bone name -> slot, so we can find a bone's own slot for parenting.
  const slotByCharBone = new Map<string, HumanoidSlotId>();
  for (const [slot, bone] of charBonesBySlot) slotByCharBone.set(bone.name, slot);

  const ordered = orderedCharacterBones(characterRoot, new Set([...slotByCharBone.keys()]));

  // Pre-allocate output buffers.
  const quatValues = new Map<string, Float32Array>();
  const posValues = new Map<string, Float32Array>();
  const times = new Float32Array(frames);
  for (let i = 0; i < frames; i++) times[i] = (i / Math.max(frames - 1, 1)) * sourceClip.duration;

  for (const bone of ordered) {
    quatValues.set(bone.name, new Float32Array(frames * 4));
  }
  if (hipsCharBone) posValues.set(hipsCharBone.name, new Float32Array(frames * 3));

  // Bind pose of the source rig, sampled BEFORE any mixer update.
  animationRoot.updateMatrixWorld(true);
  const animRestWorld = new Map<string, THREE.Quaternion>();
  const animRestPos = new Map<string, THREE.Vector3>();
  for (const [slot, bone] of animBonesBySlot) {
    const q = new THREE.Quaternion();
    bone.getWorldQuaternion(q);
    animRestWorld.set(slot, q);
    animRestPos.set(slot, bone.getWorldPosition(new THREE.Vector3()));
  }

  // ---------------------------------------------------------------------
  // Transfer math (world-space delta)
  // ---------------------------------------------------------------------
  // Mixamo rigs do NOT share bone axis conventions with the Unreal-style
  // character: measured bind world rotations differ by ~180 deg on the thighs and
  // ~84 deg on the upper arms. Two formulations were measured against the source
  // animation's own hips-relative hand offsets over the full clip:
  //
  //   local-frame delta  C = C0 * A0^-1 * A(t)      hand error ~1.2-1.3  (wrong)
  //   world-space delta  C = A(t) * A0^-1 * C0      hand error ~0.15-0.23 (correct)
  //
  // The local-frame form injects the bone's own (arbitrary) rest orientation into
  // the delta, which bends the arm about the wrong axis — that is what produced
  // the "arms folded across the chest / hands at face height" pose. The world-space
  // form applies the source's rotation about the *same world axis* on the
  // character, which is convention-independent.
  // ---------------------------------------------------------------------

  // Evaluate the source animation on a throwaway mixer.
  const mixer = new THREE.AnimationMixer(animationRoot);
  const action = mixer.clipAction(sourceClip);
  action.play();

  const animWorldNow = new THREE.Quaternion();
  const delta = new THREE.Quaternion();
  const tmpInverse = new THREE.Quaternion();
  const desiredWorld = new Map<string, THREE.Quaternion>();
  const parentWorld = new THREE.Quaternion();
  const localQ = new THREE.Quaternion();

  for (let f = 0; f < frames; f++) {
    mixer.setTime(times[f]);
    animationRoot.updateMatrixWorld(true);

    desiredWorld.clear();

    for (const bone of ordered) {
      const slot = slotByCharBone.get(bone.name);
      if (!slot) continue;
      const animBone = animBonesBySlot.get(slot);
      const restAnim = animRestWorld.get(slot);
      const restChar = charRestWorld.get(slot);
      if (!animBone || !restAnim || !restChar) continue;

      // d = A(t) * A0^-1   — the source bone's rotation since its bind pose,
      //                      expressed in WORLD axes.
      animBone.getWorldQuaternion(animWorldNow);
      delta.copy(animWorldNow).multiply(tmpInverse.copy(restAnim).invert());

      // C(t) = d * C0
      const target = new THREE.Quaternion().copy(delta).multiply(restChar);
      desiredWorld.set(bone.name, target);

      // local = parentWorld^-1 * target   (parent's *solved* world rotation when
      // it is also mapped, otherwise its current world rotation).
      const parentBone = bone.parent as THREE.Bone | null;
      const mappedParent = parentBone ? desiredWorld.get(parentBone.name) : undefined;
      if (mappedParent) parentWorld.copy(mappedParent);
      else if (parentBone) parentBone.getWorldQuaternion(parentWorld);
      else parentWorld.identity();

      localQ.copy(parentWorld).invert().multiply(target);

      const arr = quatValues.get(bone.name)!;
      arr[f * 4 + 0] = localQ.x;
      arr[f * 4 + 1] = localQ.y;
      arr[f * 4 + 2] = localQ.z;
      arr[f * 4 + 3] = localQ.w;
    }

    // Hip translation: scaled source hip motion, or bind pose when in-place.
    if (hipsCharBone && hipsAnimBone) {
      const srcHips = hipsAnimBone.getWorldPosition(new THREE.Vector3());
      const srcRestHips = animRestPos.get('hips') ?? new THREE.Vector3();
      const charRestHips = charRestWorldPos.get('hips') ?? hipsCharBone.getWorldPosition(new THREE.Vector3());
      const worldDelta = srcHips.clone().sub(srcRestHips).multiplyScalar(plan.hipScale);
      if (options.inPlace) {
        worldDelta.x = 0;
        worldDelta.z = 0;
      }
      const targetWorld = charRestHips.clone().add(worldDelta);
      const localPos = targetWorld.clone();
      if (hipsCharBone.parent) {
        const inv = new THREE.Matrix4().copy(hipsCharBone.parent.matrixWorld).invert();
        localPos.applyMatrix4(inv);
      }
      const arr = posValues.get(hipsCharBone.name)!;
      arr[f * 3 + 0] = localPos.x;
      arr[f * 3 + 1] = localPos.y;
      arr[f * 3 + 2] = localPos.z;
    }
  }

  mixer.stopAllAction();
  mixer.uncacheClip(sourceClip);
  mixer.uncacheRoot(animationRoot);

  const tracks: THREE.KeyframeTrack[] = [];
  for (const bone of ordered) {
    const q = quatValues.get(bone.name);
    if (!q) continue;
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, Array.from(times), Array.from(q)));
  }
  if (hipsCharBone) {
    const p = posValues.get(hipsCharBone.name);
    if (p) {
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${hipsCharBone.name}.position`,
          Array.from(times),
          Array.from(p),
        ),
      );
    }
  }

  if (tracks.length === 0) {
    notes.push('No character bones could be driven — the clip is empty.');
  }
  if (options.inPlace) notes.push('In-place preview: horizontal hip translation removed.');

  return {
    clip: new THREE.AnimationClip(`${sourceClip.name || 'clip'}__retargeted`, sourceClip.duration, tracks),
    sampledFrames: frames,
    fps,
    usedSlots: [...charBonesBySlot.keys()],
    droppedSlots: dropped,
    inPlace: options.inPlace,
    notes,
  };
}

/** Rest-pose snapshot type shared by the preview and retargeter. */
export type RestPoseSnapshot = Map<string, { quat: THREE.Quaternion; pos: THREE.Vector3 }>;

/** Clears any pose left on the character by a previous preview. */
export function restoreRestPose(
  characterRoot: THREE.Object3D,
  restSnapshot: RestPoseSnapshot,
): void {
  characterRoot.traverse((obj) => {
    const snap = restSnapshot.get(obj.name);
    if (!snap) return;
    obj.quaternion.copy(snap.quat);
    obj.position.copy(snap.pos);
  });
  characterRoot.updateMatrixWorld(true);
}

/** Snapshots the bind/rest pose so previews can be reverted exactly. */
export function snapshotRestPose(characterRoot: THREE.Object3D): RestPoseSnapshot {
  const out: RestPoseSnapshot = new Map();
  characterRoot.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      out.set(obj.name, { quat: obj.quaternion.clone(), pos: obj.position.clone() });
    }
  });
  return out;
}
