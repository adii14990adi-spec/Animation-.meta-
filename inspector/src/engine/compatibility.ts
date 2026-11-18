/**
 * Animation -> character compatibility analysis.
 *
 * Every verdict is produced by the explicit, inspectable rules in
 * `scoring.ruleTrace`. There is no opaque score: the status is derived from
 * required-slot coverage, hierarchy validation, track matching and rest-pose
 * agreement, and each input is reported alongside the verdict.
 */

import * as THREE from 'three';
import type {
  BoneMappingEntry,
  CompatibilityIssue,
  CompatibilityReport,
  CompatibilityStatus,
  HumanoidSlotId,
  NormalizedSkeleton,
  ParsedAnimationResult,
  RestPoseComparison,
  TrackAnalysis,
} from './animationTypes';
import {
  SLOT_DEFINITIONS,
  SLOT_ORDER,
  matchHumanoidSlots,
  normalizeBoneName,
  type SlotMatch,
} from './humanoidRegistry';

export const PHASE2_LIMITATIONS: string[] = [
  'Browser-side analysis only. This is NOT Unity Editor and NOT Unity AvatarBuilder validation.',
  'Bone matching is name/alias/hierarchy based; similar names do not by themselves prove matching bone orientation.',
  'Retargeted preview playback is geometry-level retargeting, not a substitute for Unity runtime verification.',
  'FBX authored FPS is not exposed by the parser; when a rate is shown it is inferred from keyframe density and labelled as such.',
];

/** Rest-pose rotation difference above which a limb pair is flagged. */
export const REST_ROTATION_WARN_DEG = 45;
/** Limb-length ratio deviation above which proportions are flagged. */
export const LIMB_LENGTH_WARN_RATIO = 0.35;

function boneWorldPos(skeleton: NormalizedSkeleton, name: string): THREE.Vector3 | null {
  const bone = skeleton.bones.find((b) => b.name === name);
  if (!bone) return null;
  return new THREE.Vector3(...bone.restWorldPosition);
}

function quatFromTuple(q: [number, number, number, number]): THREE.Quaternion {
  return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
}

/** World-space rest orientation of a bone, composed from the local chain. */
function worldRestQuaternion(skeleton: NormalizedSkeleton, name: string): THREE.Quaternion | null {
  const chain: NormalizedSkeleton['bones'] = [];
  let cursor = skeleton.bones.find((b) => b.name === name);
  if (!cursor) return null;
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parentIndex === null ? undefined! : skeleton.bones[cursor.parentIndex];
  }
  const q = new THREE.Quaternion();
  for (const node of chain) q.multiply(quatFromTuple(node.restQuaternion));
  return q;
}

/**
 * Compares the animation's rest pose against the character's rest pose.
 * Both sides are read from the same normalized representation, so units differ
 * (cm vs m) but orientations and *ratios* are directly comparable.
 */
export function compareRestPose(
  animationSkeleton: NormalizedSkeleton,
  characterSkeleton: NormalizedSkeleton,
  mappings: BoneMappingEntry[],
): RestPoseComparison {
  const slotsExceedingRotationThreshold: HumanoidSlotId[] = [];
  const slotsExceedingLengthThreshold: HumanoidSlotId[] = [];
  let maxRot = 0;
  let maxLenRatio = 0;
  const notes: string[] = [];

  for (const m of mappings) {
    if (!m.animationBone || !m.characterBone) continue;

    const aq = worldRestQuaternion(animationSkeleton, m.animationBone);
    const cq = worldRestQuaternion(characterSkeleton, m.characterBone);
    if (aq && cq) {
      const deg = THREE.MathUtils.radToDeg(aq.angleTo(cq));
      maxRot = Math.max(maxRot, deg);
      if (deg > REST_ROTATION_WARN_DEG) slotsExceedingRotationThreshold.push(m.slot);
    }

    // Limb-length ratio: compare the distance from this bone to its mapped child.
    const def = SLOT_DEFINITIONS[m.slot];
    const childSlot = SLOT_ORDER.find((s) => SLOT_DEFINITIONS[s].parent === m.slot);
    if (childSlot) {
      const childMap = mappings.find((x) => x.slot === childSlot);
      if (childMap?.animationBone && childMap.characterBone) {
        const a1 = boneWorldPos(animationSkeleton, m.animationBone);
        const a2 = boneWorldPos(animationSkeleton, childMap.animationBone);
        const c1 = boneWorldPos(characterSkeleton, m.characterBone);
        const c2 = boneWorldPos(characterSkeleton, childMap.characterBone);
        if (a1 && a2 && c1 && c2) {
          // Normalize both rigs by their own hip height so units cancel.
          const aHip = mappings.find((x) => x.slot === 'hips');
          const aHipPos = aHip?.animationBone ? boneWorldPos(animationSkeleton, aHip.animationBone) : null;
          const cHipPos = aHip?.characterBone ? boneWorldPos(characterSkeleton, aHip.characterBone) : null;
          const aUnit = aHipPos ? Math.abs(aHipPos.y) || 1 : 1;
          const cUnit = cHipPos ? Math.abs(cHipPos.y) || 1 : 1;
          const aLen = a1.distanceTo(a2) / aUnit;
          const cLen = c1.distanceTo(c2) / cUnit;
          if (aLen > 1e-6) {
            const ratio = Math.abs(cLen - aLen) / aLen;
            maxLenRatio = Math.max(maxLenRatio, ratio);
            if (ratio > LIMB_LENGTH_WARN_RATIO) slotsExceedingLengthThreshold.push(m.slot);
          }
        }
      }
    }
    void def;
  }

  if (maxRot > REST_ROTATION_WARN_DEG) {
    notes.push(
      `Largest rest-orientation difference is ${maxRot.toFixed(1)}° on ${slotsExceedingRotationThreshold.length} slot(s); world-space delta transfer compensates, but visual checks are required.`,
    );
  }
  if (maxLenRatio > LIMB_LENGTH_WARN_RATIO) {
    notes.push(
      `Limb proportions differ by up to ${(maxLenRatio * 100).toFixed(0)}% on ${slotsExceedingLengthThreshold.length} slot(s) (normalized by hip height).`,
    );
  }

  return {
    maxRestRotationDeltaDeg: Number(maxRot.toFixed(2)),
    maxLimbLengthDeviationRatio: Number(maxLenRatio.toFixed(4)),
    slotsExceedingRotationThreshold,
    slotsExceedingLengthThreshold,
    notes,
  };
}

/** Builds slot mappings between an animation and a character. */
export function buildMappings(
  animationSkeleton: NormalizedSkeleton,
  characterSkeleton: NormalizedSkeleton,
): { mappings: BoneMappingEntry[]; animationMatches: Record<HumanoidSlotId, SlotMatch>; characterMatches: Record<HumanoidSlotId, SlotMatch> } {
  const animationMatches = matchHumanoidSlots(animationSkeleton);
  const characterMatches = matchHumanoidSlots(characterSkeleton);

  const animationNodes = new Map(animationSkeleton.bones.map((b) => [b.name, b]));

  const mappings: BoneMappingEntry[] = SLOT_ORDER.map((slot) => {
    const def = SLOT_DEFINITIONS[slot];
    const a = animationMatches[slot];
    const c = characterMatches[slot];
    const notes: string[] = [];

    // Hierarchy validation: the animation bone's parent must resolve to the
    // character bone's parent slot (or the chain must at least be consistent).
    let hierarchyValid: boolean | null = null;
    if (a.bone && c.bone && def.parent) {
      const animNode = animationNodes.get(a.bone);
      const expectedParentSlot = def.parent;
      const expectedAnimParent = animationMatches[expectedParentSlot].bone;
      const charParentBone = characterMatches[expectedParentSlot].bone;
      if (animNode && expectedAnimParent && charParentBone) {
        hierarchyValid = animNode.parentName === expectedAnimParent;
        if (!hierarchyValid) {
          notes.push(
            `Animation bone "${a.bone}" parent is "${animNode.parentName ?? '(none)'}", expected "${expectedAnimParent}" for slot ${expectedParentSlot}.`,
          );
        }
      }
    }

    if (a.ambiguousCandidates.length > 0) {
      notes.push(`Ambiguous animation-side candidates: ${a.ambiguousCandidates.join(', ')}.`);
    }

    return {
      slot,
      animationBone: a.bone,
      characterBone: c.bone,
      method: a.bone ? a.method : 'unresolved',
      confidence: a.bone && c.bone ? Math.min(a.confidence, c.confidence) : a.bone ? a.confidence * 0.5 : 0,
      hierarchyValid,
      sideValid: a.bone && c.bone ? true : null,
      notes,
    };
  });

  return { mappings, animationMatches, characterMatches };
}

function analyzeTracks(
  animation: ParsedAnimationResult,
  mappings: BoneMappingEntry[],
  characterSkeleton: NormalizedSkeleton,
): TrackAnalysis {
  // Bones that will actually drive the character = mapped animation bones.
  const mappedAnimBones = new Set(
    mappings.filter((m) => m.animationBone && m.characterBone).map((m) => m.animationBone!),
  );
  // Bones that belong to a humanoid slot but failed to map, or extra detail
  // bones above the mapped level (finger phalanges 2-4, *_leaf tips).
  const slotBones = new Set(Object.values(animation.skeleton!.detectedHumanoidSlots));

  const matchedBones = new Set<string>();
  const unmatchedDetail: string[] = [];
  let total = 0;
  let matched = 0;
  let extraDetail = 0;

  for (const clip of animation.clips) {
    for (const bone of clip.animatedBones) {
      total += 1;
      if (mappedAnimBones.has(bone)) {
        matched += 1;
        matchedBones.add(bone);
        continue;
      }
      const isDetailBone = /(\d|_leaf|leaf|_end)$/i.test(bone.replace(/^mixamorig/i, ''));
      if (isDetailBone && !slotBones.has(bone)) {
        extraDetail += 1;
        unmatchedDetail.push(`${bone} (extra detail bone above mapped level)`);
      } else {
        unmatchedDetail.push(`${bone} (animated but no mapped humanoid slot)`);
      }
    }
    for (const t of clip.unsupportedTracks) {
      extraDetail += 1;
      unmatchedDetail.push(`${t} (track does not target a parsed bone)`);
    }
  }

  void characterSkeleton;
  return {
    totalTracks: total,
    matchedTracks: matched,
    unmatchedTracks: Math.max(total - matched - extraDetail, 0),
    extraDetailTracks: extraDetail,
    matchedBones: [...matchedBones].sort(),
    unmatchedTracks_detail: unmatchedDetail.slice(0, 80),
  };
}

function validateHierarchy(mappings: BoneMappingEntry[], animationSkeleton: NormalizedSkeleton) {
  const nodes = new Map(animationSkeleton.bones.map((b) => [b.name, b]));
  const mismatches: Array<{ slot: HumanoidSlotId; expectedParentSlot: HumanoidSlotId; animationParent: string | null }> = [];
  let checked = 0;
  let valid = 0;

  for (const m of mappings) {
    const def = SLOT_DEFINITIONS[m.slot];
    if (!m.animationBone || !def.parent) continue;
    const mappedParent = mappings.find((x) => x.slot === def.parent);
    if (!mappedParent?.animationBone) continue;
    const node = nodes.get(m.animationBone);
    if (!node) continue;
    checked += 1;
    if (node.parentName === mappedParent.animationBone) {
      valid += 1;
    } else {
      mismatches.push({
        slot: m.slot,
        expectedParentSlot: def.parent,
        animationParent: node.parentName,
      });
    }
  }
  return { checkedParents: checked, validParents: valid, mismatches };
}

function validateSides(
  mappings: BoneMappingEntry[],
  animationSkeleton: NormalizedSkeleton,
): { checked: number; violations: Array<{ slot: HumanoidSlotId; animationBone: string; reason: string }> } {
  const violations: Array<{ slot: HumanoidSlotId; animationBone: string; reason: string }> = [];
  let checked = 0;

  for (const m of mappings) {
    const def = SLOT_DEFINITIONS[m.slot];
    if (!m.animationBone || def.side === 'center') continue;
    checked += 1;
    const normalized = normalizeBoneName(m.animationBone);
    const looksLeft = /left/.test(normalized) || /[a-z]l$/.test(normalized);
    const looksRight = /right/.test(normalized) || /[a-z]r$/.test(normalized);
    if (def.side === 'left' && looksRight && !looksLeft) {
      violations.push({
        slot: m.slot,
        animationBone: m.animationBone,
        reason: 'left-side slot resolved to a right-side bone',
      });
    }
    if (def.side === 'right' && looksLeft && !looksRight) {
      violations.push({
        slot: m.slot,
        animationBone: m.animationBone,
        reason: 'right-side slot resolved to a left-side bone',
      });
    }
    if (!looksLeft && !looksRight) {
      violations.push({
        slot: m.slot,
        animationBone: m.animationBone,
        reason: 'sided slot resolved to a bone with no side marker — treat as ambiguous',
      });
    }
  }
  void animationSkeleton;
  return { checked, violations };
}

export interface CompatibilityInput {
  animation: ParsedAnimationResult;
  characterSlot: 'male' | 'female';
  characterSkeleton: NormalizedSkeleton;
}

/**
 * Scores one animation against one character.
 *
 * Status rules (in order):
 *  - PROCESSING_FAILED  : the animation could not be parsed.
 *  - INCOMPATIBLE       : <80% of required slots mapped, or hierarchy valid <70%.
 *  - PARTIALLY_COMPATIBLE: 80–99% required coverage, or hierarchy <90%, or >30% tracks unmatched.
 *  - COMPATIBLE_WITH_WARNINGS: everything mapped but warnings exist (rest pose, ambiguity, unmatched tracks).
 *  - COMPATIBLE         : 100% required coverage, all hierarchy valid, rest pose within thresholds.
 */
export function analyzeCompatibility(input: CompatibilityInput): CompatibilityReport {
  const { animation, characterSlot, characterSkeleton } = input;
  const issues: CompatibilityIssue[] = [];

  if (animation.status !== 'ok' || !animation.skeleton) {
    return {
      assetId: animation.assetId,
      sourcePath: animation.sourcePath,
      fileName: animation.fileName,
      characterSlot,
      status: 'PROCESSING_FAILED',
      scoring: {
        requiredSlotsTotal: 0,
        requiredSlotsMapped: 0,
        requiredSlotCoverage: 0,
        hierarchyValidCount: 0,
        hierarchyCheckedCount: 0,
        trackMatchRatio: 0,
        meanMappingConfidence: 0,
        restPoseOk: false,
        ruleTrace: [`Animation could not be parsed: ${animation.error ?? 'unknown error'}`],
      },
      requiredBonesFound: [],
      requiredBonesMissing: [],
      trackAnalysis: { totalTracks: 0, matchedTracks: 0, unmatchedTracks: 0, extraDetailTracks: 0, matchedBones: [], unmatchedTracks_detail: [] },
      hierarchy: { checkedParents: 0, validParents: 0, mismatches: [] },
      sideValidation: { checked: 0, violations: [] },
      restPose: {
        maxRestRotationDeltaDeg: null,
        maxLimbLengthDeviationRatio: null,
        slotsExceedingRotationThreshold: [],
        slotsExceedingLengthThreshold: [],
        notes: [],
      },
      retargetReadiness: 'not_ready',
      issues: [
        {
          severity: 'error',
          code: 'ANIMATION_PARSE_FAILED',
          message: animation.error ?? 'FBX could not be parsed.',
          basis: 'confirmed_fact',
        },
      ],
      limitations: PHASE2_LIMITATIONS,
    };
  }

  const { mappings } = buildMappings(animation.skeleton, characterSkeleton);
  const requiredSlots = SLOT_ORDER.filter((s) => SLOT_DEFINITIONS[s].required);
  const requiredFound = mappings.filter((m) => SLOT_DEFINITIONS[m.slot].required && m.animationBone && m.characterBone);
  const requiredMissing = requiredSlots.filter(
    (s) => !mappings.find((m) => m.slot === s && m.animationBone && m.characterBone),
  );

  const hierarchy = validateHierarchy(mappings, animation.skeleton);
  const sideValidation = validateSides(mappings, animation.skeleton);
  const restPose = compareRestPose(animation.skeleton, characterSkeleton, mappings);
  const trackAnalysis = analyzeTracks(animation, mappings, characterSkeleton);

  const requiredCoverage = requiredSlots.length === 0 ? 0 : requiredFound.length / requiredSlots.length;
  const hierarchyRatio = hierarchy.checkedParents === 0 ? 1 : hierarchy.validParents / hierarchy.checkedParents;
  // Track ratio measures how much of the animation's *slot-level* motion is
  // carried over. Extra detail bones (finger phalanges, leaf tips) are excluded
  // from the denominator because the character rig has no slot for them.
  const scoredTrackTotal = trackAnalysis.matchedTracks + trackAnalysis.unmatchedTracks;
  const trackMatchRatio = scoredTrackTotal === 0 ? 0 : trackAnalysis.matchedTracks / scoredTrackTotal;
  const confidenceValues = mappings.filter((m) => m.animationBone && m.characterBone).map((m) => m.confidence);
  const meanConfidence =
    confidenceValues.length === 0 ? 0 : confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length;

  const restPoseOk =
    (restPose.maxRestRotationDeltaDeg ?? 0) <= REST_ROTATION_WARN_DEG &&
    (restPose.maxLimbLengthDeviationRatio ?? 0) <= LIMB_LENGTH_WARN_RATIO;

  // Warnings / errors
  if (requiredMissing.length > 0) {
    issues.push({
      severity: requiredMissing.length > 3 ? 'error' : 'warning',
      code: 'REQUIRED_SLOTS_MISSING',
      message: `${requiredMissing.length} of ${requiredSlots.length} required humanoid slot(s) unmapped: ${requiredMissing.join(', ')}.`,
      basis: 'confirmed_fact',
    });
  }
  if (hierarchy.mismatches.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'HIERARCHY_MISMATCH',
      message: `${hierarchy.mismatches.length} mapped bone(s) have a different parent than the canonical humanoid chain (e.g. ${hierarchy.mismatches
        .slice(0, 3)
        .map((m) => `${m.slot} parent "${m.animationParent ?? '(none)'}"`)
        .join('; ')}).`,
      basis: 'confirmed_fact',
    });
  }
  if (sideValidation.violations.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'SIDE_VALIDATION',
      message: `${sideValidation.violations.length} side validation issue(s): ${sideValidation.violations
        .slice(0, 3)
        .map((v) => `${v.slot} -> ${v.animationBone} (${v.reason})`)
        .join('; ')}.`,
      basis: 'heuristic',
    });
  }
  if (!restPoseOk) {
    issues.push({
      severity: 'warning',
      code: 'REST_POSE_DIVERGENCE',
      message: `Rest pose differs beyond thresholds (max rotation Δ ${restPose.maxRestRotationDeltaDeg ?? 0}°, max limb-length Δ ${(
        (restPose.maxLimbLengthDeviationRatio ?? 0) * 100
      ).toFixed(0)}%). Retargeting compensates in world space, but visual verification is required.`,
      basis: 'confirmed_fact',
    });
  }
  if (trackAnalysis.unmatchedTracks > 0) {
    issues.push({
      severity: 'warning',
      code: 'UNMATCHED_TRACKS',
      message: `${trackAnalysis.unmatchedTracks} animated bone(s) belong to a humanoid slot but could not be mapped to the character.`,
      basis: 'confirmed_fact',
    });
  }
  if (trackAnalysis.extraDetailTracks > 0) {
    issues.push({
      severity: 'info',
      code: 'EXTRA_DETAIL_TRACKS',
      message: `${trackAnalysis.extraDetailTracks} animated bone(s) are outside the 32 humanoid slots (finger phalanges 2-4 / *_leaf tips). They are not retargeted and do not reduce compatibility.`,
      basis: 'confirmed_fact',
    });
  }
  const ambiguousSlots = mappings.filter((m) => !m.animationBone && m.method === 'unresolved');
  if (ambiguousSlots.length > 0) {
    issues.push({
      severity: 'info',
      code: 'UNMAPPED_OPTIONAL_SLOTS',
      message: `${ambiguousSlots.length} slot(s) left unmapped (ambiguous or absent): ${ambiguousSlots.map((m) => m.slot).join(', ')}.`,
      basis: 'heuristic',
    });
  }
  for (const w of animation.warnings) {
    issues.push({ severity: 'info', code: 'ANIMATION_PARSE_WARNING', message: w, basis: 'confirmed_fact' });
  }

  // Status derivation — transparent, ordered rules.
  const ruleTrace: string[] = [];
  let status: CompatibilityStatus;

  ruleTrace.push(`Required slot coverage: ${requiredFound.length}/${requiredSlots.length} (${(requiredCoverage * 100).toFixed(1)}%).`);
  ruleTrace.push(`Hierarchy validation: ${hierarchy.validParents}/${hierarchy.checkedParents} valid (${(hierarchyRatio * 100).toFixed(1)}%).`);
  ruleTrace.push(
    `Track matching: ${trackAnalysis.matchedTracks}/${scoredTrackTotal} slot-level animated bones matched (${(trackMatchRatio * 100).toFixed(
      1,
    )}%); ${trackAnalysis.extraDetailTracks} extra detail bone(s) excluded from scoring.`,
  );
  ruleTrace.push(`Mean mapping confidence: ${(meanConfidence * 100).toFixed(1)}%.`);
  ruleTrace.push(
    `Rest pose: rotation Δ ${restPose.maxRestRotationDeltaDeg ?? 0}° (threshold ${REST_ROTATION_WARN_DEG}°), limb-length Δ ${(
      (restPose.maxLimbLengthDeviationRatio ?? 0) * 100
    ).toFixed(1)}% (threshold ${LIMB_LENGTH_WARN_RATIO * 100}%).`,
  );

  if (requiredCoverage < 0.8 || hierarchyRatio < 0.7) {
    status = 'INCOMPATIBLE';
    ruleTrace.push('Verdict INCOMPATIBLE: required coverage <80% or hierarchy valid <70%.');
  } else if (requiredCoverage < 1 || hierarchyRatio < 0.9 || trackMatchRatio < 0.7) {
    status = 'PARTIALLY_COMPATIBLE';
    ruleTrace.push('Verdict PARTIALLY_COMPATIBLE: required coverage <100%, hierarchy <90%, or slot-level track match <70%.');
  } else {
    if (!restPoseOk) {
      ruleTrace.push(
        'Rest-pose divergence is reported as a warning: world-space delta transfer compensates for it, so it does not lower the coverage verdict.',
      );
    }
    const hasWarnings = issues.some((i) => i.severity === 'warning' || i.severity === 'error');
    if (hasWarnings || !restPoseOk) {
      status = 'COMPATIBLE_WITH_WARNINGS';
      ruleTrace.push('Verdict COMPATIBLE_WITH_WARNINGS: all required slots and hierarchy valid, but warnings are present.');
    } else {
      status = 'COMPATIBLE';
      ruleTrace.push('Verdict COMPATIBLE: all required slots mapped, hierarchy valid, rest pose within thresholds, no warnings.');
    }
  }

  const retargetReadiness: CompatibilityReport['retargetReadiness'] =
    status === 'INCOMPATIBLE'
      ? 'not_ready'
      : status === 'COMPATIBLE'
        ? 'ready'
        : 'ready_with_warnings';

  return {
    assetId: animation.assetId,
    sourcePath: animation.sourcePath,
    fileName: animation.fileName,
    characterSlot,
    status,
    scoring: {
      requiredSlotsTotal: requiredSlots.length,
      requiredSlotsMapped: requiredFound.length,
      requiredSlotCoverage: Number(requiredCoverage.toFixed(4)),
      hierarchyValidCount: hierarchy.validParents,
      hierarchyCheckedCount: hierarchy.checkedParents,
      trackMatchRatio: Number(trackMatchRatio.toFixed(4)),
      meanMappingConfidence: Number(meanConfidence.toFixed(4)),
      restPoseOk,
      ruleTrace,
    },
    requiredBonesFound: requiredFound.map((m) => `${m.slot}:${m.animationBone}`),
    requiredBonesMissing: requiredMissing,
    trackAnalysis,
    hierarchy,
    sideValidation,
    restPose,
    retargetReadiness,
    issues,
    limitations: PHASE2_LIMITATIONS,
  };
}

/** Category inference used by the library filters (filename rules only). */
export function categorizeAnimation(fileName: string): string {
  const n = fileName.toLowerCase();
  // Weapon-specific clips are classified by their equipment context first, so
  // "rifle aiming idle" does not get lumped in with plain locomotion idles.
  if (/rifle|reload|fire|aim|grenade/.test(n)) return 'Weapon';
  if (/idle|stand|wait/.test(n)) return 'Idle';
  if (/sprint/.test(n)) return 'Sprint';
  if (/run|jog/.test(n)) return 'Run';
  if (/walk/.test(n)) return 'Walk';
  if (/crouch/.test(n)) return 'Crouch';
  if (/jump/.test(n)) return 'Jump';
  if (/death|dying|die/.test(n)) return 'Death';
  if (/turn/.test(n)) return 'Turn';
  if (/strafe/.test(n)) return 'Strafe';
  if (/swim|skate|dive|roll/.test(n)) return 'Traversal';
  if (/hit|reaction/.test(n)) return 'Reaction';
  return 'Other';
}
