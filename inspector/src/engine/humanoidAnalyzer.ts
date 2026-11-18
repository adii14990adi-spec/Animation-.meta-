import type {
  BoneNodeReport,
  HumanoidAnalysisSummary,
  HumanoidBoneKey,
  HumanoidBoneSlotReport,
  HumanoidStructureStatus,
  SkeletonReport,
} from './types';

interface SlotDefinition {
  key: HumanoidBoneKey;
  label: string;
  group: 'Torso & Head' | 'Left Arm' | 'Right Arm' | 'Left Leg' | 'Right Leg';
  isCoreBipedalSlot: boolean;
  side: 'center' | 'left' | 'right';
  strongTokens: RegExp[];
  possibleTokens: RegExp[];
  expectedAncestorSlot?: HumanoidBoneKey;
}

const EXCLUDED_HELPER_RE =
  /(?:^|[_.\-:\s])(ik|fk|pole|target|ctrl|control|helper|twist|roll|end|nub|leaf|socket|weapon|gun|rifle|sword|shield|cape|cloak|skirt|cloth|hair|ponytail|braid|eye|eyebrow|eyelash|lid|jaw|tongue|teeth|tooth|ear|nose|cheek|lip|brow|breast|boob|pec|pectoral|butt|glute)(?:$|[_.\-:\s\d])/i;

const FINGER_RE =
  /(?:^|[_.\-:\s])(thumb|index|middle|mid|ring|pinky|little|finger|metacarpal|carpal|digit|phalange)(?:$|[_.\-:\s\d])/i;

const TOE_RE = /(?:^|[_.\-:\s])(toe|toes|ball|hallux)(?:$|[_.\-:\s\d])/i;

export function stripRigPrefix(rawName: string): string {
  return rawName
    .trim()
    .replace(/^.*\|/, '')
    .replace(/^mixamorig\d*[:_]?/i, '')
    .replace(/^cc_base_/i, '')
    .replace(/^j_bip_[clr]_/i, (m) => {
      const sideChar = m.charAt(6).toLowerCase();
      if (sideChar === 'l') return 'left_';
      if (sideChar === 'r') return 'right_';
      return '';
    })
    .replace(/^(def|org|mch)[-_]/i, '')
    .replace(/^bip\d+\s+/i, '');
}

export function detectBoneSide(rawName: string): 'left' | 'right' | 'center' {
  const trimmed = rawName.trim();
  if (/^j_bip_l_/i.test(trimmed)) return 'left';
  if (/^j_bip_r_/i.test(trimmed)) return 'right';

  const s = stripRigPrefix(trimmed);
  if (/(?:^|[_.\-:\s])left(?:$|[_.\-:\s\d])|left[A-Z]/i.test(s)) {
    if (/left/i.test(s) && !/right/i.test(s)) return 'left';
  }
  if (/(?:^|[_.\-:\s])right(?:$|[_.\-:\s\d])|right[A-Z]/i.test(s)) {
    if (/right/i.test(s) && !/left/i.test(s)) return 'right';
  }
  if (
    /(?:[_.\-:\s])l(?:$|\d+$)/i.test(s) ||
    /^l(?:[_.\-:\s]|[A-Z])/.test(s)
  ) {
    return 'left';
  }
  if (
    /(?:[_.\-:\s])r(?:$|\d+$)/i.test(s) ||
    /^r(?:[_.\-:\s]|[A-Z])/.test(s)
  ) {
    return 'right';
  }
  return 'center';
}

function cleanAnatomicalStem(rawName: string): string {
  const s = stripRigPrefix(rawName)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[.\-:\s]+/g, '_');

  const parts = s
    .split('_')
    .filter(
      (tok) =>
        tok.length > 0 &&
        tok !== 'left' &&
        tok !== 'right' &&
        tok !== 'l' &&
        tok !== 'r' &&
        tok !== 'c',
    );
  return parts.join('_');
}

const HUMANOID_SLOTS: SlotDefinition[] = [
  {
    key: 'hips',
    label: 'Hips',
    group: 'Torso & Head',
    isCoreBipedalSlot: true,
    side: 'center',
    strongTokens: [/^(hips?|pelvis|hip_bone)$/i],
    possibleTokens: [/^(root_hips|cog|center_of_gravity|waist|torso_root|spine_00|spine00)$/i],
  },
  {
    key: 'spine',
    label: 'Spine',
    group: 'Torso & Head',
    isCoreBipedalSlot: true,
    side: 'center',
    strongTokens: [/^(spine|spine_?0?1|spine_a|abdomen|lower_back|waist)$/i],
    possibleTokens: [/^(spine_?0|back_?0?1|torso_?0?1|lumbar)$/i],
    expectedAncestorSlot: 'hips',
  },
  {
    key: 'chest',
    label: 'Chest',
    group: 'Torso & Head',
    isCoreBipedalSlot: false,
    side: 'center',
    strongTokens: [/^(chest|upper_?chest|spine_?1|spine_?0?2|spine_?2|spine_?0?3|thorax|ribcage)$/i],
    possibleTokens: [/^(torso|upper_?body|upper_?torso|back_?0?2)$/i],
    expectedAncestorSlot: 'spine',
  },
  {
    key: 'neck',
    label: 'Neck',
    group: 'Torso & Head',
    isCoreBipedalSlot: false,
    side: 'center',
    strongTokens: [/^(neck|neck_?0?1|cervical)$/i],
    possibleTokens: [/^(neck_?base|neck_?a|neck_?0)$/i],
    expectedAncestorSlot: 'spine',
  },
  {
    key: 'head',
    label: 'Head',
    group: 'Torso & Head',
    isCoreBipedalSlot: true,
    side: 'center',
    strongTokens: [/^(head|head_?0?1|cranium|skull)$/i],
    possibleTokens: [/^(head_?bone|head_?base)$/i],
    expectedAncestorSlot: 'spine',
  },
  {
    key: 'leftShoulder',
    label: 'Left Shoulder',
    group: 'Left Arm',
    isCoreBipedalSlot: false,
    side: 'left',
    strongTokens: [/^(shoulder|clavicle|collar|collarbone)(?:_?0?1)?$/i],
    possibleTokens: [/^(scapula|shoulder_?base)$/i],
    expectedAncestorSlot: 'spine',
  },
  {
    key: 'rightShoulder',
    label: 'Right Shoulder',
    group: 'Right Arm',
    isCoreBipedalSlot: false,
    side: 'right',
    strongTokens: [/^(shoulder|clavicle|collar|collarbone)(?:_?0?1)?$/i],
    possibleTokens: [/^(scapula|shoulder_?base)$/i],
    expectedAncestorSlot: 'spine',
  },
  {
    key: 'leftUpperArm',
    label: 'Left Upper Arm',
    group: 'Left Arm',
    isCoreBipedalSlot: true,
    side: 'left',
    strongTokens: [/^(upper_?arm|up_?arm|arm|bicep|humerus)(?:_?0?1)?$/i],
    possibleTokens: [/^(arm_?upper|arm_?1|arm_?01)$/i],
    expectedAncestorSlot: 'spine',
  },
  {
    key: 'rightUpperArm',
    label: 'Right Upper Arm',
    group: 'Right Arm',
    isCoreBipedalSlot: true,
    side: 'right',
    strongTokens: [/^(upper_?arm|up_?arm|arm|bicep|humerus)(?:_?0?1)?$/i],
    possibleTokens: [/^(arm_?upper|arm_?1|arm_?01)$/i],
    expectedAncestorSlot: 'spine',
  },
  {
    key: 'leftLowerArm',
    label: 'Left Lower Arm',
    group: 'Left Arm',
    isCoreBipedalSlot: true,
    side: 'left',
    strongTokens: [/^(lower_?arm|low_?arm|fore_?arm|elbow|ulna|radius)(?:_?0?1)?$/i],
    possibleTokens: [/^(arm_?lower|arm_?2|arm_?02)$/i],
    expectedAncestorSlot: 'leftUpperArm',
  },
  {
    key: 'rightLowerArm',
    label: 'Right Lower Arm',
    group: 'Right Arm',
    isCoreBipedalSlot: true,
    side: 'right',
    strongTokens: [/^(lower_?arm|low_?arm|fore_?arm|elbow|ulna|radius)(?:_?0?1)?$/i],
    possibleTokens: [/^(arm_?lower|arm_?2|arm_?02)$/i],
    expectedAncestorSlot: 'rightUpperArm',
  },
  {
    key: 'leftHand',
    label: 'Left Hand',
    group: 'Left Arm',
    isCoreBipedalSlot: true,
    side: 'left',
    strongTokens: [/^(hand|wrist|palm)(?:_?0?1)?$/i],
    possibleTokens: [/^(hand_?base|arm_?3|arm_?03)$/i],
    expectedAncestorSlot: 'leftLowerArm',
  },
  {
    key: 'rightHand',
    label: 'Right Hand',
    group: 'Right Arm',
    isCoreBipedalSlot: true,
    side: 'right',
    strongTokens: [/^(hand|wrist|palm)(?:_?0?1)?$/i],
    possibleTokens: [/^(hand_?base|arm_?3|arm_?03)$/i],
    expectedAncestorSlot: 'rightLowerArm',
  },
  {
    key: 'leftUpperLeg',
    label: 'Left Upper Leg',
    group: 'Left Leg',
    isCoreBipedalSlot: true,
    side: 'left',
    strongTokens: [/^(upper_?leg|up_?leg|thigh|femur)(?:_?0?1)?$/i],
    possibleTokens: [/^(leg_?upper|leg_?1|leg_?01|hip_?leg)$/i],
    expectedAncestorSlot: 'hips',
  },
  {
    key: 'rightUpperLeg',
    label: 'Right Upper Leg',
    group: 'Right Leg',
    isCoreBipedalSlot: true,
    side: 'right',
    strongTokens: [/^(upper_?leg|up_?leg|thigh|femur)(?:_?0?1)?$/i],
    possibleTokens: [/^(leg_?upper|leg_?1|leg_?01|hip_?leg)$/i],
    expectedAncestorSlot: 'hips',
  },
  {
    key: 'leftLowerLeg',
    label: 'Left Lower Leg',
    group: 'Left Leg',
    isCoreBipedalSlot: true,
    side: 'left',
    strongTokens: [/^(lower_?leg|low_?leg|calf|shin|knee|leg|tibia)(?:_?0?1)?$/i],
    possibleTokens: [/^(leg_?lower|leg_?2|leg_?02)$/i],
    expectedAncestorSlot: 'leftUpperLeg',
  },
  {
    key: 'rightLowerLeg',
    label: 'Right Lower Leg',
    group: 'Right Leg',
    isCoreBipedalSlot: true,
    side: 'right',
    strongTokens: [/^(lower_?leg|low_?leg|calf|shin|knee|leg|tibia)(?:_?0?1)?$/i],
    possibleTokens: [/^(leg_?lower|leg_?2|leg_?02)$/i],
    expectedAncestorSlot: 'rightUpperLeg',
  },
  {
    key: 'leftFoot',
    label: 'Left Foot',
    group: 'Left Leg',
    isCoreBipedalSlot: true,
    side: 'left',
    strongTokens: [/^(foot|ankle)(?:_?0?1)?$/i],
    possibleTokens: [/^(foot_?base|leg_?3|leg_?03)$/i],
    expectedAncestorSlot: 'leftLowerLeg',
  },
  {
    key: 'rightFoot',
    label: 'Right Foot',
    group: 'Right Leg',
    isCoreBipedalSlot: true,
    side: 'right',
    strongTokens: [/^(foot|ankle)(?:_?0?1)?$/i],
    possibleTokens: [/^(foot_?base|leg_?3|leg_?03)$/i],
    expectedAncestorSlot: 'rightLowerLeg',
  },
];

export function detectRigNamingScheme(boneNames: string[]): {
  scheme: string;
  isMixamo: boolean;
} {
  if (boneNames.length === 0) {
    return { scheme: 'None (No bones)', isMixamo: false };
  }

  const mixamoCount = boneNames.filter((b) => /^mixamorig\d*[:_]/i.test(b)).length;
  if (mixamoCount >= Math.max(3, Math.floor(boneNames.length * 0.25))) {
    return { scheme: 'Mixamo (mixamorig:* convention)', isMixamo: true };
  }

  const unrealCount = boneNames.filter((b) =>
    /^(pelvis|spine_01|clavicle_[lr]|upperarm_[lr]|lowerarm_[lr]|thigh_[lr]|calf_[lr])$/i.test(b),
  ).length;
  if (unrealCount >= 4) {
    return { scheme: 'Unreal Mannequin (pelvis / *_l / *_r convention)', isMixamo: false };
  }

  const vrmCount = boneNames.filter((b) => /^J_Bip_[CLR]_/i.test(b)).length;
  if (vrmCount >= 4) {
    return { scheme: 'VRM / UniVRM (J_Bip_* convention)', isMixamo: false };
  }

  const ccCount = boneNames.filter((b) => /^CC_Base_/i.test(b)).length;
  if (ccCount >= 4) {
    return { scheme: 'Reallusion Character Creator (CC_Base_*)', isMixamo: false };
  }

  const bipedCount = boneNames.filter((b) => /^Bip\d+\s+/i.test(b)).length;
  if (bipedCount >= 4) {
    return { scheme: '3ds Max Biped (Bip01 / Bip001)', isMixamo: false };
  }

  const rigifyCount = boneNames.filter(
    (b) => /^(DEF-|ORG-|MCH-)/i.test(b) || /\.(L|R)$/i.test(b),
  ).length;
  if (rigifyCount >= 4) {
    return { scheme: 'Blender / Rigify (.L / .R suffix convention)', isMixamo: false };
  }

  const mixamoUnprefixedCount = boneNames.filter((b) =>
    /^(Hips|LeftUpLeg|RightUpLeg|LeftForeArm|RightForeArm)$/i.test(b),
  ).length;
  if (mixamoUnprefixedCount >= 3) {
    return { scheme: 'Standard / Unprefixed Mixamo-like Humanoid', isMixamo: false };
  }

  return { scheme: 'Custom / Non-standard Naming', isMixamo: false };
}

function isDescendantOf(
  bones: BoneNodeReport[],
  childJointIndex: number,
  ancestorJointIndex: number,
): boolean {
  const visited = new Set<number>();
  let cursor = bones[childJointIndex]?.parentJointIndex ?? null;
  while (cursor !== null && !visited.has(cursor)) {
    if (cursor === ancestorJointIndex) return true;
    visited.add(cursor);
    cursor = bones[cursor]?.parentJointIndex ?? null;
  }
  return false;
}

export function analyzeHumanoidStructure(
  skeletons: SkeletonReport[],
): HumanoidAnalysisSummary {
  const disclaimer =
    'Heuristic browser-side analysis based on bone naming conventions and parent-child topology only. This does NOT invoke Unity Editor AvatarBuilder and does NOT guarantee Unity Humanoid import or runtime animation retargeting compatibility.';

  if (skeletons.length === 0 || skeletons[0].bones.length === 0) {
    return {
      status: 'Unknown',
      detectedNamingPattern: 'None (No skeleton detected)',
      mixamoStyleDetected: false,
      totalSlotsChecked: HUMANOID_SLOTS.length,
      foundCount: 0,
      possibleMatchCount: 0,
      ambiguousCount: 0,
      missingCount: HUMANOID_SLOTS.length,
      coreSlotsSatisfiedCount: 0,
      coreSlotsTotalCount: HUMANOID_SLOTS.filter((s) => s.isCoreBipedalSlot).length,
      hierarchyPlausible: false,
      slots: HUMANOID_SLOTS.map((slot) => ({
        key: slot.key,
        label: slot.label,
        group: slot.group,
        isCoreBipedalSlot: slot.isCoreBipedalSlot,
        status: 'Missing',
        matchedBoneName: null,
        matchedJointIndex: null,
        candidateBoneNames: [],
        reason: 'No skeleton bones present in GLTF.',
      })),
      heuristicDisclaimer: disclaimer,
    };
  }

  const primary = [...skeletons].sort((a, b) => {
    if (b.connectedSkinnedMeshNames.length !== a.connectedSkinnedMeshNames.length) {
      return b.connectedSkinnedMeshNames.length - a.connectedSkinnedMeshNames.length;
    }
    return b.totalBoneCount - a.totalBoneCount;
  })[0];

  const { scheme, isMixamo } = detectRigNamingScheme(primary.boneNames);
  const usedJointIndices = new Set<number>();
  const resolvedJointBySlot = new Map<HumanoidBoneKey, number>();

  const boneMeta = primary.bones.map((bone) => {
    const raw = bone.name;
    const isHelper = EXCLUDED_HELPER_RE.test(raw);
    const isFinger = FINGER_RE.test(raw);
    const isToe = TOE_RE.test(raw);
    const side = detectBoneSide(raw);
    const stem = cleanAnatomicalStem(raw);
    return {
      bone,
      raw,
      isHelper,
      isFinger,
      isToe,
      side,
      stem,
    };
  });

  const hasExplicitUpperLeg = {
    left: boneMeta.some(
      (m) =>
        m.side === 'left' &&
        !m.isHelper &&
        /^(upper_?leg|up_?leg|thigh|femur)(?:_?0?1)?$/i.test(m.stem),
    ),
    right: boneMeta.some(
      (m) =>
        m.side === 'right' &&
        !m.isHelper &&
        /^(upper_?leg|up_?leg|thigh|femur)(?:_?0?1)?$/i.test(m.stem),
    ),
  };

  const slotReports: HumanoidBoneSlotReport[] = [];

  for (const slot of HUMANOID_SLOTS) {
    const strongCandidates: BoneNodeReport[] = [];
    const possibleCandidates: BoneNodeReport[] = [];

    for (const meta of boneMeta) {
      if (usedJointIndices.has(meta.bone.jointIndex)) continue;
      if (meta.bone.isEmptyName) continue;
      if (meta.isHelper || meta.isFinger || meta.isToe) continue;
      if (meta.side !== slot.side) continue;

      if (
        (slot.key === 'leftLowerLeg' || slot.key === 'rightLowerLeg') &&
        /^leg(?:_?0?1)?$/i.test(meta.stem)
      ) {
        const sideHasUpper =
          slot.side === 'left' ? hasExplicitUpperLeg.left : hasExplicitUpperLeg.right;
        if (sideHasUpper) {
          strongCandidates.push(meta.bone);
        } else {
          possibleCandidates.push(meta.bone);
        }
        continue;
      }

      if (slot.strongTokens.some((re) => re.test(meta.stem))) {
        strongCandidates.push(meta.bone);
      } else if (slot.possibleTokens.some((re) => re.test(meta.stem))) {
        possibleCandidates.push(meta.bone);
      }
    }

    let effectiveStrong = strongCandidates;
    if (slot.key === 'chest' && strongCandidates.length > 1) {
      const spineIdx = resolvedJointBySlot.get('spine');
      const descendants =
        spineIdx !== undefined
          ? strongCandidates.filter((b) => isDescendantOf(primary.bones, b.jointIndex, spineIdx))
          : strongCandidates;
      const nonDuplicates = descendants.filter((b) => !b.isDuplicateName);
      if (nonDuplicates.length >= 1) {
        const minDepth = Math.min(...nonDuplicates.map((b) => b.depth));
        const shallowest = nonDuplicates.filter((b) => b.depth === minDepth);
        if (shallowest.length === 1) {
          effectiveStrong = shallowest;
        }
      }
    }

    if (effectiveStrong.length > 1) {
      slotReports.push({
        key: slot.key,
        label: slot.label,
        group: slot.group,
        isCoreBipedalSlot: slot.isCoreBipedalSlot,
        status: 'Ambiguous',
        matchedBoneName: null,
        matchedJointIndex: null,
        candidateBoneNames: effectiveStrong.map((c) => c.name),
        reason: `Multiple competing bones (${effectiveStrong.map((c) => `"${c.name}"`).join(', ')}) match ${slot.label}.`,
      });
      continue;
    }

    if (effectiveStrong.length === 1) {
      const chosen = effectiveStrong[0];
      if (chosen.isDuplicateName) {
        slotReports.push({
          key: slot.key,
          label: slot.label,
          group: slot.group,
          isCoreBipedalSlot: slot.isCoreBipedalSlot,
          status: 'Ambiguous',
          matchedBoneName: chosen.name,
          matchedJointIndex: chosen.jointIndex,
          candidateBoneNames: [chosen.name],
          reason: `Bone "${chosen.name}" appears multiple times in the skeleton (duplicate bone name).`,
        });
        continue;
      }

      let topologyValid = true;
      if (slot.expectedAncestorSlot !== undefined) {
        const expectedParentJoint = resolvedJointBySlot.get(slot.expectedAncestorSlot);
        if (
          expectedParentJoint !== undefined &&
          !isDescendantOf(primary.bones, chosen.jointIndex, expectedParentJoint)
        ) {
          topologyValid = false;
        }
      }

      usedJointIndices.add(chosen.jointIndex);
      resolvedJointBySlot.set(slot.key, chosen.jointIndex);

      if (topologyValid) {
        slotReports.push({
          key: slot.key,
          label: slot.label,
          group: slot.group,
          isCoreBipedalSlot: slot.isCoreBipedalSlot,
          status: 'Found',
          matchedBoneName: chosen.name,
          matchedJointIndex: chosen.jointIndex,
          candidateBoneNames: [chosen.name],
          reason: `Matched bone "${chosen.name}" (joint #${chosen.jointIndex}, depth ${chosen.depth}) with consistent hierarchy.`,
        });
      } else {
        slotReports.push({
          key: slot.key,
          label: slot.label,
          group: slot.group,
          isCoreBipedalSlot: slot.isCoreBipedalSlot,
          status: 'Possible match',
          matchedBoneName: chosen.name,
          matchedJointIndex: chosen.jointIndex,
          candidateBoneNames: [chosen.name],
          reason: `Name matches "${chosen.name}", but parent chain does not descend from ${slot.expectedAncestorSlot}.`,
        });
      }
      continue;
    }

    if (possibleCandidates.length > 1) {
      slotReports.push({
        key: slot.key,
        label: slot.label,
        group: slot.group,
        isCoreBipedalSlot: slot.isCoreBipedalSlot,
        status: 'Ambiguous',
        matchedBoneName: null,
        matchedJointIndex: null,
        candidateBoneNames: possibleCandidates.map((c) => c.name),
        reason: `Multiple heuristic candidates (${possibleCandidates.map((c) => `"${c.name}"`).join(', ')}) could represent ${slot.label}.`,
      });
      continue;
    }

    if (possibleCandidates.length === 1) {
      const chosen = possibleCandidates[0];
      usedJointIndices.add(chosen.jointIndex);
      resolvedJointBySlot.set(slot.key, chosen.jointIndex);
      slotReports.push({
        key: slot.key,
        label: slot.label,
        group: slot.group,
        isCoreBipedalSlot: slot.isCoreBipedalSlot,
        status: chosen.isDuplicateName ? 'Ambiguous' : 'Possible match',
        matchedBoneName: chosen.name,
        matchedJointIndex: chosen.jointIndex,
        candidateBoneNames: [chosen.name],
        reason: chosen.isDuplicateName
          ? `Heuristic candidate "${chosen.name}" is duplicated in the skeleton.`
          : `Heuristic bone name "${chosen.name}" (joint #${chosen.jointIndex}) plausibly corresponds to ${slot.label}.`,
      });
      continue;
    }

    slotReports.push({
      key: slot.key,
      label: slot.label,
      group: slot.group,
      isCoreBipedalSlot: slot.isCoreBipedalSlot,
      status: 'Missing',
      matchedBoneName: null,
      matchedJointIndex: null,
      candidateBoneNames: [],
      reason: `No bone matching ${slot.label} was detected in skeleton "${primary.name}".`,
    });
  }

  const foundCount = slotReports.filter((s) => s.status === 'Found').length;
  const possibleMatchCount = slotReports.filter((s) => s.status === 'Possible match').length;
  const ambiguousCount = slotReports.filter((s) => s.status === 'Ambiguous').length;
  const missingCount = slotReports.filter((s) => s.status === 'Missing').length;

  const coreSlots = slotReports.filter((s) => s.isCoreBipedalSlot);
  const coreSlotsSatisfiedCount = coreSlots.filter(
    (s) => s.status === 'Found' || s.status === 'Possible match',
  ).length;
  const coreAmbiguousCount = coreSlots.filter((s) => s.status === 'Ambiguous').length;

  const hipsJoint = resolvedJointBySlot.get('hips');
  const headJoint = resolvedJointBySlot.get('head');
  const lHandJoint = resolvedJointBySlot.get('leftHand');
  const rHandJoint = resolvedJointBySlot.get('rightHand');
  const lFootJoint = resolvedJointBySlot.get('leftFoot');
  const rFootJoint = resolvedJointBySlot.get('rightFoot');

  const hierarchyPlausible =
    hipsJoint !== undefined &&
    headJoint !== undefined &&
    lHandJoint !== undefined &&
    rHandJoint !== undefined &&
    lFootJoint !== undefined &&
    rFootJoint !== undefined &&
    isDescendantOf(primary.bones, headJoint, hipsJoint) &&
    isDescendantOf(primary.bones, lHandJoint, hipsJoint) &&
    isDescendantOf(primary.bones, rHandJoint, hipsJoint) &&
    isDescendantOf(primary.bones, lFootJoint, hipsJoint) &&
    isDescendantOf(primary.bones, rFootJoint, hipsJoint);

  let status: HumanoidStructureStatus;
  if (
    coreSlotsSatisfiedCount === coreSlots.length &&
    coreAmbiguousCount === 0 &&
    hierarchyPlausible
  ) {
    status = 'Likely';
  } else if (foundCount + possibleMatchCount + ambiguousCount >= 3) {
    status = 'Incomplete';
  } else {
    status = 'Unknown';
  }

  return {
    status,
    detectedNamingPattern: scheme,
    mixamoStyleDetected: isMixamo,
    totalSlotsChecked: HUMANOID_SLOTS.length,
    foundCount,
    possibleMatchCount,
    ambiguousCount,
    missingCount,
    coreSlotsSatisfiedCount,
    coreSlotsTotalCount: coreSlots.length,
    hierarchyPlausible,
    slots: slotReports,
    heuristicDisclaimer: disclaimer,
  };
}
