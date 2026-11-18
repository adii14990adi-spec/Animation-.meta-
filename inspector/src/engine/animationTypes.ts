/**
 * Phase 2 — Animation compatibility inspection types.
 *
 * These types describe the normalized, transportable representation of an FBX
 * animation skeleton and the results of comparing it against a character rig.
 * They are deliberately free of Three.js objects so they can cross a Web Worker
 * boundary via structured clone (and be serialized into downloadable reports).
 */

/** One discovered animation FBX in the repository library. */
export interface AnimationAssetEntry {
  /** Stable id derived from the repository-relative path. */
  id: string;
  /** Repository-relative source path, e.g. `animations/idle.fbx`. */
  sourcePath: string;
  /** Bare filename, e.g. `idle.fbx`. */
  fileName: string;
  /** Category inferred from filename/config rules (heuristic). */
  category: string;
  sizeBytes: number;
  /** SHA-256 of the raw bytes — used for de-duplication and result caching. */
  sha256: string;
  /** Non-fatal classification notes, e.g. duplicate detection. */
  notes: string[];
  /** True when another asset shares the same SHA-256. */
  duplicateOf: string | null;
}

export interface AnimationDiscoveryReport {
  scannedDirectories: string[];
  totalFilesScanned: number;
  animationFiles: number;
  duplicates: number;
  /** Files excluded because they are not animation FBX assets. */
  excluded: Array<{ sourcePath: string; reason: string }>;
  assets: AnimationAssetEntry[];
  /** Expected repository count used for a visible pass/fail assertion (null = not asserted). */
  expectedCount: number | null;
  matchesExpectedCount: boolean;
  /** True when discovery did not rely on any hardcoded filename list. */
  discoveryStrategy: string;
}

/** A single bone in a normalized skeleton. */
export interface NormalizedBone {
  name: string;
  index: number;
  parentIndex: number | null;
  parentName: string | null;
  /** Bone names from root down to this bone (inclusive). */
  path: string[];
  /** Depth from the skeleton root (root = 0). */
  depth: number;
  /** Local rest translation from the parsed FBX. */
  restPosition: [number, number, number];
  /** Local rest rotation quaternion from the parsed FBX. */
  restQuaternion: [number, number, number, number];
  /** Local rest scale from the parsed FBX. */
  restScale: [number, number, number];
  /** World-space rest position, used for side/orientation sanity checks. */
  restWorldPosition: [number, number, number];
  childNames: string[];
}

/** Canonical humanoid slots the mapping engine resolves to concrete bone names. */
export type HumanoidSlotId =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftLowerArm'
  | 'rightLowerArm'
  | 'leftHand'
  | 'rightHand'
  | 'leftUpperLeg'
  | 'rightUpperLeg'
  | 'leftLowerLeg'
  | 'rightLowerLeg'
  | 'leftFoot'
  | 'rightFoot'
  | 'leftToe'
  | 'rightToe'
  | 'leftThumb'
  | 'rightThumb'
  | 'leftIndex'
  | 'rightIndex'
  | 'leftMiddle'
  | 'rightMiddle'
  | 'leftRing'
  | 'rightRing'
  | 'leftPinky'
  | 'rightPinky';

export interface AnimationClipSummary {
  name: string;
  durationSeconds: number | null;
  trackCount: number;
  /** Track property suffixes present, e.g. `quaternion`, `position`, `scale`. */
  trackProperties: string[];
  /** Track names that do not resolve to a bone in the parsed skeleton. */
  unsupportedTracks: string[];
  /** Distinct bone names that have at least one animation track. */
  animatedBones: string[];
  /**
   * Frames-per-second as *inferred from keyframe density*. FBXLoader does not
   * expose the authored FPS, so this is explicitly a derived estimate.
   */
  inferredFps: number | null;
  fpsBasis: 'not_available' | 'inferred_from_key_density';
}

export interface NormalizedSkeleton {
  boneCount: number;
  bones: NormalizedBone[];
  rootBoneNames: string[];
  /** Bones with zero children. */
  leafBoneNames: string[];
  duplicateBoneNames: string[];
  emptyNameCount: number;
  /** Humanoid slots detected purely from names on the animation side. */
  detectedHumanoidSlots: Partial<Record<HumanoidSlotId, string>>;
  maxDepth: number;
}

export type AnimationParseStatus = 'ok' | 'failed';

export interface ParsedAnimationResult {
  assetId: string;
  sourcePath: string;
  fileName: string;
  sha256: string;
  status: AnimationParseStatus;
  error: string | null;
  /** Milliseconds spent parsing (worker-side). */
  parseMs: number;
  skeleton: NormalizedSkeleton | null;
  clips: AnimationClipSummary[];
  /** Convenience: duration of the longest clip. */
  durationSeconds: number | null;
  /** Warnings not tied to a specific clip. */
  warnings: string[];
}

/** Mapping of a canonical humanoid slot to a concrete animation bone. */
export interface BoneMappingEntry {
  slot: HumanoidSlotId;
  animationBone: string | null;
  characterBone: string | null;
  /** How the animation bone was resolved. */
  method: 'exact' | 'alias' | 'hierarchy' | 'unresolved' | 'manual';
  /** 0..1 — how confident the automatic resolution is. */
  confidence: number;
  /** Parent-child relationship validated against the character rig. */
  hierarchyValid: boolean | null;
  /** Left/right side agreement between the animation bone and character bone. */
  sideValid: boolean | null;
  notes: string[];
}

export interface BoneMappingProfile {
  id: string;
  animationSignature: string;
  characterSignature: string;
  createdAtIso: string;
  entries: BoneMappingEntry[];
  /** Slots whose automatic resolution was ambiguous. */
  ambiguousSlots: HumanoidSlotId[];
  /** True when the profile was edited by a human through the UI. */
  manuallyAdjusted: boolean;
}

export type CompatibilityStatus =
  | 'COMPATIBLE'
  | 'COMPATIBLE_WITH_WARNINGS'
  | 'PARTIALLY_COMPATIBLE'
  | 'INCOMPATIBLE'
  | 'PROCESSING_FAILED';

export interface CompatibilityIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  slot?: HumanoidSlotId;
  basis: 'confirmed_fact' | 'heuristic';
}

export interface TrackAnalysis {
  /** Every animated bone across all clips. */
  totalTracks: number;
  /** Animated bones that resolve to a mapped humanoid slot (they will drive the character). */
  matchedTracks: number;
  /**
   * Animated bones that resolve to a humanoid slot but could NOT be mapped.
   * These are real coverage gaps and count against the verdict.
   */
  unmatchedTracks: number;
  /**
   * Animated bones above the mapped level (finger phalanges 2-4, *_leaf tips).
   * They are structurally outside the humanoid slot set, so they are reported
   * transparently but do not make an animation less compatible.
   */
  extraDetailTracks: number;
  matchedBones: string[];
  unmatchedTracks_detail: string[];
}

export interface RestPoseComparison {
  /** Largest local-rest rotation angle difference across mapped bones (degrees). */
  maxRestRotationDeltaDeg: number | null;
  /** Largest limb-length ratio deviation across mapped bones (null when unavailable). */
  maxLimbLengthDeviationRatio: number | null;
  /** Slots whose rest rotation delta exceeds the safe threshold. */
  slotsExceedingRotationThreshold: HumanoidSlotId[];
  /** Slots whose rest limb proportions differ substantially. */
  slotsExceedingLengthThreshold: HumanoidSlotId[];
  notes: string[];
}

export interface CompatibilityReport {
  assetId: string;
  sourcePath: string;
  fileName: string;
  characterSlot: 'male' | 'female';
  status: CompatibilityStatus;
  /** Transparent score inputs — no opaque AI score. */
  scoring: {
    requiredSlotsTotal: number;
    requiredSlotsMapped: number;
    requiredSlotCoverage: number;
    hierarchyValidCount: number;
    hierarchyCheckedCount: number;
    trackMatchRatio: number;
    meanMappingConfidence: number;
    restPoseOk: boolean;
    ruleTrace: string[];
  };
  requiredBonesFound: string[];
  requiredBonesMissing: HumanoidSlotId[];
  trackAnalysis: TrackAnalysis;
  hierarchy: {
    checkedParents: number;
    validParents: number;
    mismatches: Array<{ slot: HumanoidSlotId; expectedParentSlot: HumanoidSlotId; animationParent: string | null }>;
  };
  sideValidation: {
    checked: number;
    violations: Array<{ slot: HumanoidSlotId; animationBone: string; reason: string }>;
  };
  restPose: RestPoseComparison;
  retargetReadiness: 'ready' | 'ready_with_warnings' | 'not_ready';
  issues: CompatibilityIssue[];
  /** Explicit non-Unity disclaimer carried in every exported report. */
  limitations: string[];
}

export interface AnimationAnalysisBundle {
  schemaVersion: '2.0.0';
  phase: 'Phase 2 — Animation Compatibility Inspector';
  generatedAtIso: string;
  discovery: AnimationDiscoveryReport;
  animations: ParsedAnimationResult[];
  compatibility: CompatibilityReport[];
  mappings: BoneMappingProfile[];
  characterSignatures: Record<'male' | 'female', string>;
  limitations: string[];
}
