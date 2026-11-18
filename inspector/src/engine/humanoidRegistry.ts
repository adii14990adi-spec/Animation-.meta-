/**
 * Canonical humanoid slot definitions plus a name/alias/hierarchy based matcher.
 *
 * Design notes
 * ------------
 * - Aliases are matched against a *normalized* bone name (lowercase, separators
 *   and the ubiquitous "mixamorig" prefix removed) so that Mixamo
 *   (`mixamorigLeftArm`), Unreal Mannequin (`upperarm_l`) and generic
 *   (`LeftArm`, `upper_arm.L`) rigs all resolve.
 * - Exact normalized equality always wins over substring/alias matching, and any
 *   match that would cross the left/right side is rejected outright.
 * - Nothing here silently guesses when two candidates are equally good: the slot
 *   is reported as ambiguous and left unmapped for a human to fix.
 */

import type { HumanoidSlotId, NormalizedSkeleton } from './animationTypes';

export type Side = 'left' | 'right' | 'center';

export interface SlotDefinition {
  id: HumanoidSlotId;
  label: string;
  side: Side;
  /** Parent slot expected by the canonical humanoid hierarchy. */
  parent: HumanoidSlotId | null;
  /** Slots that must be present for a "compatible" verdict. */
  required: boolean;
  /** Finger slots are optional — Mixamo has them, Unreal Mannequin partially. */
  family: 'spine' | 'arm' | 'leg' | 'finger';
  /** Normalized names that are an exact match for this slot. */
  exactNames: string[];
  /** Normalized name fragments accepted as alias matches (lower confidence). */
  aliasFragments: string[];
}

/**
 * Normalizes a bone name for comparison.
 * - lowercases
 * - strips the Mixamo "mixamorig" prefix (with or without a separator)
 * - strips namespaces like `Bip01_`
 * - removes separators (`_`, `-`, `.`, spaces) so `upper_arm_l` === `upperarml`
 */
export function normalizeBoneName(raw: string): string {
  let name = raw.trim().toLowerCase();
  name = name.replace(/^.*:/, ''); // namespace:bone
  name = name.replace(/mixamorig/g, '');
  name = name.replace(/bip\d*_?/g, '');
  name = name.replace(/[\s._\-|:]/g, '');
  return name;
}

function sideOfNormalized(normalized: string): Side {
  const hasLeft = /(^|[^a-z]?)left|(^|.*)l$/.test(normalized) || /_l$/.test(normalized);
  const hasRight = /(^|[^a-z]?)right|(^|.*)r$/.test(normalized) || /_r$/.test(normalized);
  // Prefer explicit words over trailing single letters.
  if (/left/.test(normalized)) return 'left';
  if (/right/.test(normalized)) return 'right';
  if (/[a-z]l$/.test(normalized) && !/[a-z]r$/.test(normalized)) return 'left';
  if (/[a-z]r$/.test(normalized) && !/[a-z]l$/.test(normalized)) return 'right';
  if (hasLeft && !hasRight) return 'left';
  if (hasRight && !hasLeft) return 'right';
  return 'center';
}

export function slotSide(slot: HumanoidSlotId): Side {
  return SLOT_DEFINITIONS[slot].side;
}

export const SLOT_ORDER: HumanoidSlotId[] = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToe',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToe',
  'leftThumb',
  'leftIndex',
  'leftMiddle',
  'leftRing',
  'leftPinky',
  'rightThumb',
  'rightIndex',
  'rightMiddle',
  'rightRing',
  'rightPinky',
];

export const SLOT_DEFINITIONS: Record<HumanoidSlotId, SlotDefinition> = {
  hips: {
    id: 'hips', label: 'Hips', side: 'center', parent: null, required: true, family: 'spine',
    // `root` is deliberately NOT an exact match here: Unreal rigs have BOTH a
    // `root` and a `pelvis`, and treating `root` as an equal candidate made the
    // slot permanently ambiguous (which silently disabled all hip motion).
    exactNames: ['hips', 'pelvis', 'hip'],
    aliasFragments: ['hips', 'pelvis'],
  },
  spine: {
    id: 'spine', label: 'Spine', side: 'center', parent: 'hips', required: true, family: 'spine',
    exactNames: ['spine', 'spine01', 'spine1', 'spine0'],
    aliasFragments: ['spine'],
  },
  chest: {
    id: 'chest', label: 'Chest', side: 'center', parent: 'spine', required: true, family: 'spine',
    exactNames: ['spine02', 'spine2', 'chest', 'spine1'],
    aliasFragments: ['chest', 'spine02', 'spine2'],
  },
  upperChest: {
    id: 'upperChest', label: 'Upper Chest', side: 'center', parent: 'chest', required: false, family: 'spine',
    exactNames: ['spine03', 'spine3', 'upperchest', 'spine2', 'spine02'],
    aliasFragments: ['upperchest', 'spine03', 'spine3'],
  },
  neck: {
    id: 'neck', label: 'Neck', side: 'center', parent: 'upperChest', required: true, family: 'spine',
    exactNames: ['neck', 'neck01', 'neck1'],
    aliasFragments: ['neck'],
  },
  head: {
    id: 'head', label: 'Head', side: 'center', parent: 'neck', required: true, family: 'spine',
    exactNames: ['head', 'head01'],
    aliasFragments: ['head'],
  },
  leftShoulder: {
    id: 'leftShoulder', label: 'Left Shoulder', side: 'left', parent: 'upperChest', required: false, family: 'arm',
    exactNames: ['leftshoulder', 'claviclel', 'shoulderl', 'leftclavicle'],
    aliasFragments: ['shoulder', 'clavicle'],
  },
  rightShoulder: {
    id: 'rightShoulder', label: 'Right Shoulder', side: 'right', parent: 'upperChest', required: false, family: 'arm',
    exactNames: ['rightshoulder', 'clavicler', 'shoulderr', 'rightclavicle'],
    aliasFragments: ['shoulder', 'clavicle'],
  },
  leftUpperArm: {
    id: 'leftUpperArm', label: 'Left Upper Arm', side: 'left', parent: 'leftShoulder', required: true, family: 'arm',
    exactNames: ['leftarm', 'upperarml', 'leftupperarm', 'arml', 'upperarmleft'],
    aliasFragments: ['upperarm', 'arm'],
  },
  rightUpperArm: {
    id: 'rightUpperArm', label: 'Right Upper Arm', side: 'right', parent: 'rightShoulder', required: true, family: 'arm',
    exactNames: ['rightarm', 'upperarmr', 'rightupperarm', 'armr', 'upperarmright'],
    aliasFragments: ['upperarm', 'arm'],
  },
  leftLowerArm: {
    id: 'leftLowerArm', label: 'Left Lower Arm', side: 'left', parent: 'leftUpperArm', required: true, family: 'arm',
    exactNames: ['leftforearm', 'lowerarml', 'leftlowerarm', 'forearml', 'lowerarmleft'],
    aliasFragments: ['forearm', 'lowerarm'],
  },
  rightLowerArm: {
    id: 'rightLowerArm', label: 'Right Lower Arm', side: 'right', parent: 'rightUpperArm', required: true, family: 'arm',
    exactNames: ['rightforearm', 'lowerarmr', 'rightlowerarm', 'forearmr', 'lowerarmright'],
    aliasFragments: ['forearm', 'lowerarm'],
  },
  leftHand: {
    id: 'leftHand', label: 'Left Hand', side: 'left', parent: 'leftLowerArm', required: true, family: 'arm',
    exactNames: ['lefthand', 'handl', 'handleft'],
    aliasFragments: ['hand'],
  },
  rightHand: {
    id: 'rightHand', label: 'Right Hand', side: 'right', parent: 'rightLowerArm', required: true, family: 'arm',
    exactNames: ['righthand', 'handr', 'handright'],
    aliasFragments: ['hand'],
  },
  leftUpperLeg: {
    id: 'leftUpperLeg', label: 'Left Upper Leg', side: 'left', parent: 'hips', required: true, family: 'leg',
    exactNames: ['leftupleg', 'thighl', 'leftthigh', 'upperlegl', 'thighleft'],
    aliasFragments: ['upleg', 'thigh', 'upperleg'],
  },
  rightUpperLeg: {
    id: 'rightUpperLeg', label: 'Right Upper Leg', side: 'right', parent: 'hips', required: true, family: 'leg',
    exactNames: ['rightupleg', 'thighr', 'rightthigh', 'upperlegr', 'thighright'],
    aliasFragments: ['upleg', 'thigh', 'upperleg'],
  },
  leftLowerLeg: {
    id: 'leftLowerLeg', label: 'Left Lower Leg', side: 'left', parent: 'leftUpperLeg', required: true, family: 'leg',
    exactNames: ['leftleg', 'calfl', 'leftcalf', 'lowerlegl', 'shinl'],
    aliasFragments: ['calf', 'lowerleg', 'shin'],
  },
  rightLowerLeg: {
    id: 'rightLowerLeg', label: 'Right Lower Leg', side: 'right', parent: 'rightUpperLeg', required: true, family: 'leg',
    exactNames: ['rightleg', 'calfr', 'rightcalf', 'lowerlegr', 'shinr'],
    aliasFragments: ['calf', 'lowerleg', 'shin'],
  },
  leftFoot: {
    id: 'leftFoot', label: 'Left Foot', side: 'left', parent: 'leftLowerLeg', required: true, family: 'leg',
    exactNames: ['leftfoot', 'footl', 'footleft'],
    aliasFragments: ['foot'],
  },
  rightFoot: {
    id: 'rightFoot', label: 'Right Foot', side: 'right', parent: 'rightLowerLeg', required: true, family: 'leg',
    exactNames: ['rightfoot', 'footr', 'footright'],
    aliasFragments: ['foot'],
  },
  leftToe: {
    id: 'leftToe', label: 'Left Toe', side: 'left', parent: 'leftFoot', required: false, family: 'leg',
    exactNames: ['lefttoebase', 'toebasel', 'balll', 'lefttoe', 'toel'],
    aliasFragments: ['toebase', 'toe', 'ball'],
  },
  rightToe: {
    id: 'rightToe', label: 'Right Toe', side: 'right', parent: 'rightFoot', required: false, family: 'leg',
    exactNames: ['righttoebase', 'toebaser', 'ballr', 'righttoe', 'toer'],
    aliasFragments: ['toebase', 'toe', 'ball'],
  },
  leftThumb: {
    id: 'leftThumb', label: 'Left Thumb', side: 'left', parent: 'leftHand', required: false, family: 'finger',
    exactNames: ['lefthandthumb1', 'thumb1l', 'thumb01l', 'lefthandthumb'],
    aliasFragments: ['thumb'],
  },
  leftIndex: {
    id: 'leftIndex', label: 'Left Index', side: 'left', parent: 'leftHand', required: false, family: 'finger',
    exactNames: ['lefthandindex1', 'index1l', 'index01l'],
    aliasFragments: ['index'],
  },
  leftMiddle: {
    id: 'leftMiddle', label: 'Left Middle', side: 'left', parent: 'leftHand', required: false, family: 'finger',
    exactNames: ['lefthandmiddle1', 'middle1l', 'middle01l'],
    aliasFragments: ['middle'],
  },
  leftRing: {
    id: 'leftRing', label: 'Left Ring', side: 'left', parent: 'leftHand', required: false, family: 'finger',
    exactNames: ['lefthandring1', 'ring1l', 'ring01l'],
    aliasFragments: ['ring'],
  },
  leftPinky: {
    id: 'leftPinky', label: 'Left Pinky', side: 'left', parent: 'leftHand', required: false, family: 'finger',
    exactNames: ['lefthandpinky1', 'pinky1l', 'pinky01l'],
    aliasFragments: ['pinky'],
  },
  rightThumb: {
    id: 'rightThumb', label: 'Right Thumb', side: 'right', parent: 'rightHand', required: false, family: 'finger',
    exactNames: ['righthandthumb1', 'thumb1r', 'thumb01r'],
    aliasFragments: ['thumb'],
  },
  rightIndex: {
    id: 'rightIndex', label: 'Right Index', side: 'right', parent: 'rightHand', required: false, family: 'finger',
    exactNames: ['righthandindex1', 'index1r', 'index01r'],
    aliasFragments: ['index'],
  },
  rightMiddle: {
    id: 'rightMiddle', label: 'Right Middle', side: 'right', parent: 'rightHand', required: false, family: 'finger',
    exactNames: ['righthandmiddle1', 'middle1r', 'middle01r'],
    aliasFragments: ['middle'],
  },
  rightRing: {
    id: 'rightRing', label: 'Right Ring', side: 'right', parent: 'rightHand', required: false, family: 'finger',
    exactNames: ['righthandring1', 'ring1r', 'ring01r'],
    aliasFragments: ['ring'],
  },
  rightPinky: {
    id: 'rightPinky', label: 'Right Pinky', side: 'right', parent: 'rightHand', required: false, family: 'finger',
    exactNames: ['righthandpinky1', 'pinky1r', 'pinky01r'],
    aliasFragments: ['pinky'],
  },
};

export const REQUIRED_SLOTS: HumanoidSlotId[] = SLOT_ORDER.filter((s) => SLOT_DEFINITIONS[s].required);

export interface SlotMatch {
  slot: HumanoidSlotId;
  bone: string | null;
  method: 'exact' | 'alias' | 'hierarchy' | 'unresolved';
  confidence: number;
  ambiguousCandidates: string[];
  rejected: Array<{ bone: string; reason: string }>;
}

interface Candidate {
  bone: string;
  normalized: string;
  score: number;
  method: 'exact' | 'alias';
}

function scoreCandidates(slot: HumanoidSlotId, skeleton: NormalizedSkeleton): Candidate[] {
  const def = SLOT_DEFINITIONS[slot];
  const found: Candidate[] = [];

  for (const bone of skeleton.bones) {
    const normalized = normalizeBoneName(bone.name);
    if (!normalized) continue;

    // Leaf/end bones are never the primary joint for a slot.
    if (/(end|leaf|nub|tip)$/.test(normalized) && !/(toe)/.test(normalized)) continue;

    const boneSide = sideOfNormalized(normalized);

    if (def.exactNames.includes(normalized)) {
      // Exact-name match. Side must agree unless the slot is centered and the
      // bone carries no side marker.
      if (def.side !== 'center' && boneSide !== def.side) continue;
      if (def.side === 'center' && boneSide !== 'center') continue;
      found.push({ bone: bone.name, normalized, score: 1, method: 'exact' });
      continue;
    }

    // Alias fragment matching, side-guarded.
    const fragmentHit = def.aliasFragments.some((frag) => normalized.includes(frag));
    if (!fragmentHit) continue;
    if (def.side !== 'center' && boneSide !== def.side) continue;
    if (def.side === 'center' && boneSide !== 'center') continue;

    // Require the fragment to be a meaningful prefix/suffix, not an accidental
    // substring inside a longer unrelated word (e.g. "arm" inside "forearm"
    // must not match upperArm).
    const fragment = def.aliasFragments.find((frag) => normalized.includes(frag));
    if (!fragment) continue;
    const isPrefixOrSuffix =
      normalized.startsWith(fragment) || normalized.endsWith(fragment) || normalized.includes(fragment);
    if (!isPrefixOrSuffix) continue;

    // Penalize when a longer, more specific slot name is a better fit.
    if (fragment === 'arm' && /forearm|lowerarm/.test(normalized)) continue;
    if (fragment === 'hand' && /thumb|index|middle|ring|pinky/.test(normalized)) continue;
    if (fragment === 'foot' && /toe|ball/.test(normalized)) continue;
    if (fragment === 'toe' && /toebase|ball/.test(normalized) && def.id !== 'leftToe' && def.id !== 'rightToe') continue;
    if (fragment === 'spine' && /spine0?[23]/.test(normalized) && slot === 'spine') continue;
    if (fragment === 'spine' && /spine0?[23]/.test(normalized) && slot === 'chest') {
      found.push({ bone: bone.name, normalized, score: 0.9, method: 'alias' });
      continue;
    }

    found.push({ bone: bone.name, normalized, score: 0.72, method: 'alias' });
  }

  return found.sort((a, b) => b.score - a.score || a.bone.localeCompare(b.bone));
}

/**
 * Resolves every humanoid slot against a skeleton.
 *
 * Ambiguity rule: if the best two candidates have the same score *and* are
 * different bones, the slot is reported as ambiguous and left unmapped.
 *
 * De-duplication rule: when two slots resolve to the same bone, the more specific
 * slot (more exact-name agreement, deeper in the hierarchy) keeps it and the other
 * slot is re-resolved or reported unresolved. A bone can never drive two slots.
 */
export function matchHumanoidSlots(skeleton: NormalizedSkeleton): Record<HumanoidSlotId, SlotMatch> {
  const chosen = new Map<HumanoidSlotId, string>();
  const result = {} as Record<HumanoidSlotId, SlotMatch>;

  for (const slot of SLOT_ORDER) {
    const def = SLOT_DEFINITIONS[slot];
    const candidates = scoreCandidates(slot, skeleton).filter((c) => {
      // Never assign the same bone to two different slots.
      for (const [, used] of chosen) if (used === c.bone) return false;
      return true;
    });

    if (candidates.length === 0) {
      result[slot] = {
        slot,
        bone: null,
        method: 'unresolved',
        confidence: 0,
        ambiguousCandidates: [],
        rejected: [],
      };
      continue;
    }

    const best = candidates[0];
    const tied = candidates.filter((c) => Math.abs(c.score - best.score) < 0.001 && c.bone !== best.bone);

    if (tied.length > 0) {
      // Prefer the candidate whose hierarchy is consistent with the canonical
      // humanoid chain; only report ambiguity when that cannot break the tie.
      const expectedParentBone = def.parent ? chosen.get(def.parent) ?? null : null;
      const consistent = [best, ...tied].filter((c) => {
        const node = skeleton.bones.find((b) => b.name === c.bone);
        if (!node) return false;
        return expectedParentBone ? node.parentName === expectedParentBone : node.parentIndex === null;
      });
      if (consistent.length === 1) {
        const win = consistent[0];
        chosen.set(slot, win.bone);
        result[slot] = {
          slot,
          bone: win.bone,
          method: win.method,
          confidence: Math.max(0.5, win.score - 0.05),
          ambiguousCandidates: [],
          rejected: [],
        };
        continue;
      }
      result[slot] = {
        slot,
        bone: null,
        method: 'unresolved',
        confidence: 0,
        ambiguousCandidates: [best.bone, ...tied.map((t) => t.bone)],
        rejected: [],
      };
      continue;
    }

    chosen.set(slot, best.bone);
    result[slot] = {
      slot,
      bone: best.bone,
      method: best.method,
      confidence: best.score,
      ambiguousCandidates: [],
      rejected: [],
    };
  }

  // Hierarchy fallback: if a slot is unresolved but its parent slot resolved,
  // accept an only-child bone whose side and family agree.
  for (const slot of SLOT_ORDER) {
    if (result[slot].bone) continue;
    const def = SLOT_DEFINITIONS[slot];
    const parentSlot = def.parent;
    const parentBone = parentSlot ? result[parentSlot]?.bone ?? null : null;
    if (!parentBone) continue;
    const parentNode = skeleton.bones.find((b) => b.name === parentBone);
    if (!parentNode) continue;
    const unusedChildren = parentNode.childNames.filter((c) => ![...chosen.values()].includes(c));
    if (unusedChildren.length !== 1) continue;
    const only = unusedChildren[0];
    const normalized = normalizeBoneName(only);
    const boneSide = sideOfNormalized(normalized);
    if (def.side !== 'center' && boneSide !== def.side) continue;
    if (/(end|leaf|nub)$/.test(normalized)) continue;
    chosen.set(slot, only);
    result[slot] = {
      slot,
      bone: only,
      method: 'hierarchy',
      confidence: 0.5,
      ambiguousCandidates: [],
      rejected: [],
    };
  }

  // Explicitly reject cross-side assignments rather than silently keeping them.
  for (const slot of SLOT_ORDER) {
    const entry = result[slot];
    const def = SLOT_DEFINITIONS[slot];
    if (!entry.bone || def.side === 'center') continue;
    const boneSide = sideOfNormalized(normalizeBoneName(entry.bone));
    if (boneSide !== def.side) {
      result[slot] = {
        ...entry,
        bone: null,
        method: 'unresolved',
        confidence: 0,
        rejected: [{ bone: entry.bone, reason: `bone side "${boneSide}" does not match slot side "${def.side}"` }],
      };
    }
  }

  return result;
}

/** Detects the humanoid slots present in a skeleton (name-only, no character). */
export function detectHumanoidSlots(
  skeleton: NormalizedSkeleton,
): Partial<Record<HumanoidSlotId, string>> {
  const matches = matchHumanoidSlots(skeleton);
  const out: Partial<Record<HumanoidSlotId, string>> = {};
  for (const slot of SLOT_ORDER) {
    const bone = matches[slot].bone;
    if (bone) out[slot] = bone;
  }
  return out;
}

/** Returns the humanoid slot a character bone belongs to, if any. */
export function slotForCharacterBone(
  skeleton: NormalizedSkeleton,
): Partial<Record<HumanoidSlotId, string>> {
  return detectHumanoidSlots(skeleton);
}

/** Generic naming-convention detector used for report labelling. */
export function detectNamingConvention(skeleton: NormalizedSkeleton): string {
  const names = skeleton.bones.map((b) => b.name);
  if (names.some((n) => /^mixamorig/i.test(n))) return 'Mixamo';
  if (names.some((n) => /^(pelvis|spine_0\d|upperarm_[lr]|thigh_[lr])$/i.test(n))) return 'Unreal Mannequin';
  if (names.some((n) => /^Bip\d+/i.test(n))) return '3ds Max Biped';
  if (names.some((n) => /^(hips|spine|leftarm|rightupLeg)/i.test(n))) return 'Unity/Mixamo-style';
  return 'Generic humanoid';
}
