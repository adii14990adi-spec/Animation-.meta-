import type * as THREE from 'three';

export type CharacterSlotId = 'male' | 'female';

export type SkeletonStatus = 'Present' | 'Missing';
export type SkinnedMeshStatus = 'Present' | 'Missing';
export type BoneWeightsStatus = 'Valid' | 'Invalid' | 'Missing';
export type BoneHierarchyStatus = 'Valid' | 'Issues Found';
export type BindPoseStatus = 'Available' | 'Missing' | 'Invalid';
export type HumanoidStructureStatus = 'Likely' | 'Incomplete' | 'Unknown';
export type TexturesStatus = 'Loaded' | 'Missing' | 'Failed';

export type FinalClassification =
  | 'RIGGED_AND_SKINNED'
  | 'SKELETON_PRESENT_BUT_NOT_SKINNED'
  | 'SKELETON_PRESENT_WITH_WEIGHT_ISSUES'
  | 'SKELETON_MISSING'
  | 'INVALID_OR_INCOMPLETE_GLTF';

export type HumanoidBoneMatchStatus =
  | 'Found'
  | 'Missing'
  | 'Possible match'
  | 'Ambiguous';

export type UploadedFileRole = 'gltf' | 'bin' | 'texture' | 'licence' | 'other';

export interface UploadedFileEntry {
  name: string;
  relativePath: string;
  sizeBytes: number;
  role: UploadedFileRole;
}

export interface LicenceInfo {
  present: boolean;
  fileName: string | null;
  sizeBytes: number;
  lineCount: number;
  summaryNote: string;
}

export interface BufferValidationItem {
  bufferIndex: number;
  uri: string | null;
  isEmbeddedDataUri: boolean;
  declaredByteLength: number;
  actualByteLength: number | null;
  resolvedFileName: string | null;
  resolutionMode: 'exact_path' | 'basename_fallback' | 'embedded_data_uri' | 'missing';
  status: 'valid' | 'missing' | 'truncated' | 'invalid';
  error: string | null;
}

export interface TextureValidationItem {
  imageIndex: number;
  name: string;
  uri: string | null;
  sourceKind: 'external_uri' | 'embedded_data_uri' | 'buffer_view';
  mimeType: string | null;
  resolvedFileName: string | null;
  resolutionMode: 'exact_path' | 'basename_fallback' | 'embedded' | 'missing';
  sizeBytes: number | null;
  dimensions: { width: number; height: number } | null;
  status: 'loaded' | 'missing' | 'failed';
  error: string | null;
}

export interface BoneHierarchyTreeNode {
  jointIndex: number;
  gltfNodeIndex: number;
  name: string;
  depth: number;
  isRoot: boolean;
  isDuplicate: boolean;
  isUnusual: boolean;
  children: BoneHierarchyTreeNode[];
}

export interface BoneNodeReport {
  jointIndex: number;
  gltfNodeIndex: number;
  name: string;
  displayName: string;
  parentJointIndex: number | null;
  parentName: string | null;
  childJointIndices: number[];
  depth: number;
  isRoot: boolean;
  isDuplicateName: boolean;
  isEmptyName: boolean;
  isUnusualName: boolean;
  unusualReason: string | null;
  restTranslation: [number, number, number];
  restRotation: [number, number, number, number];
  restScale: [number, number, number];
  hasUnitQuaternion: boolean;
  hasValidPositiveScale: boolean;
  inverseBindDeterminant: number | null;
  inverseBindInvertible: boolean | null;
  bindWorldPosition: [number, number, number] | null;
}

export interface SkeletonReport {
  id: string;
  name: string;
  gltfSkinIndex: number | null;
  threeSkeletonDetected: boolean;
  totalBoneCount: number;
  boneNames: string[];
  rootBoneNames: string[];
  explicitSkeletonRootNodeName: string | null;
  armatureContainerNodeName: string | null;
  armatureContainerScale: [number, number, number] | null;
  maxDepth: number;
  duplicateBoneNames: string[];
  emptyBoneCount: number;
  unusualBoneNames: Array<{ name: string; reason: string }>;
  hasMultipleRoots: boolean;
  hasCycleOrBrokenParent: boolean;
  connectedSkinnedMeshNames: string[];
  bones: BoneNodeReport[];
  hierarchyTree: BoneHierarchyTreeNode[];
}

export interface MeshPrimitiveSkinningReport {
  nodeName: string;
  meshName: string;
  gltfMeshIndex: number;
  primitiveIndex: number;
  vertexCount: number;
  hasSkinReferenceOnNode: boolean;
  boundSkinIndex: number | null;
  threeIsSkinnedMesh: boolean;
  threeConnectedToSkeleton: boolean;
  hasJointsAttribute: boolean;
  hasWeightsAttribute: boolean;
  jointsSetCount: number;
  weightsSetCount: number;
  jointsComponentTypes: string[];
  weightsComponentTypes: string[];
  skeletonJointCount: number;
  validVertexCount: number;
  negativeWeightVertexCount: number;
  nonFiniteWeightVertexCount: number;
  zeroInfluenceVertexCount: number;
  unnormalizedVertexCount: number;
  outOfRangeIndexVertexCount: number;
  maxObservedJointIndex: number | null;
  minWeightSum: number | null;
  maxWeightSum: number | null;
  status: 'valid' | 'invalid' | 'not_skinned';
  notes: string[];
}

export interface SkinningValidationSummary {
  status: BoneWeightsStatus;
  totalMeshInstances: number;
  skinnedMeshCount: number;
  nonSkinnedMeshCount: number;
  disconnectedSkinAttributeMeshCount: number;
  meshAndSkeletonConsistent: boolean;
  totalSkinnedVerticesInspected: number;
  negativeWeightVertices: number;
  nonFiniteWeightVertices: number;
  zeroInfluenceVertices: number;
  unnormalizedVertices: number;
  outOfRangeJointVertices: number;
  requiresWeightNormalization: boolean;
  primitives: MeshPrimitiveSkinningReport[];
}

export interface BindPoseValidationSummary {
  status: BindPoseStatus;
  hasExplicitInverseBindMatrices: boolean;
  ibmAccessorCountMatchesJoints: boolean;
  totalMatricesChecked: number;
  nonFiniteMatrixCount: number;
  singularNonInvertibleMatrixCount: number;
  negativeDeterminantMatrixCount: number;
  invalidRestTransformBoneCount: number;
  bindBoundsMin: [number, number, number] | null;
  bindBoundsMax: [number, number, number] | null;
  estimatedRigHeight: number | null;
  detectedNamingConvention: string;
  mixamoNamingDetected: boolean;
  notes: string[];
}

export type HumanoidBoneKey =
  | 'hips'
  | 'spine'
  | 'chest'
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
  | 'rightFoot';

export interface HumanoidBoneSlotReport {
  key: HumanoidBoneKey;
  label: string;
  group: 'Torso & Head' | 'Left Arm' | 'Right Arm' | 'Left Leg' | 'Right Leg';
  isCoreBipedalSlot: boolean;
  status: HumanoidBoneMatchStatus;
  matchedBoneName: string | null;
  matchedJointIndex: number | null;
  candidateBoneNames: string[];
  reason: string;
}

export interface HumanoidAnalysisSummary {
  status: HumanoidStructureStatus;
  detectedNamingPattern: string;
  mixamoStyleDetected: boolean;
  totalSlotsChecked: number;
  foundCount: number;
  possibleMatchCount: number;
  ambiguousCount: number;
  missingCount: number;
  coreSlotsSatisfiedCount: number;
  coreSlotsTotalCount: number;
  hierarchyPlausible: boolean;
  slots: HumanoidBoneSlotReport[];
  heuristicDisclaimer: string;
}

export interface InspectionIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  title: string;
  message: string;
  category:
    | 'package'
    | 'gltf_json'
    | 'buffers'
    | 'textures'
    | 'skeleton'
    | 'hierarchy'
    | 'skinning'
    | 'bind_pose'
    | 'humanoid';
  basis: 'confirmed_fact' | 'heuristic';
}

export interface ReportStatuses {
  skeleton: SkeletonStatus;
  skinnedMesh: SkinnedMeshStatus;
  boneWeights: BoneWeightsStatus;
  boneHierarchy: BoneHierarchyStatus;
  bindPose: BindPoseStatus;
  humanoidStructure: HumanoidStructureStatus;
  textures: TexturesStatus;
}

export interface CharacterInspectionReport {
  schemaVersion: '1.0.0';
  phase: 'Phase 1 — Browser Structural Inspection Only';
  slot: CharacterSlotId;
  slotLabel: 'Male Character' | 'Female Character';
  inspectedAtIso: string;
  primaryGltfFileName: string | null;
  gltfAssetMetadata: {
    version: string | null;
    generator: string | null;
    copyright: string | null;
    minVersion: string | null;
  };
  finalClassification: FinalClassification;
  statuses: ReportStatuses;
  uploadedFiles: UploadedFileEntry[];
  licence: LicenceInfo;
  buffers: BufferValidationItem[];
  textures: TextureValidationItem[];
  sceneSummary: {
    gltfSkinCount: number;
    threeSkeletonCount: number;
    threeSkinnedMeshCount: number;
    threeStaticMeshCount: number;
    totalSceneNodes: number;
    allMeshesConnectedToSkeleton: boolean;
  };
  skeletons: SkeletonReport[];
  skinning: SkinningValidationSummary;
  bindPose: BindPoseValidationSummary;
  humanoid: HumanoidAnalysisSummary;
  confirmedFacts: string[];
  heuristicFindings: string[];
  issues: InspectionIssue[];
  limitationsNotice: string[];
}

export interface LoadedCharacterSession {
  slot: CharacterSlotId;
  sourceLabel: string;
  report: CharacterInspectionReport;
  sceneRoot: THREE.Group | null;
  skeletonBonesByJointKey: Map<string, THREE.Bone>;
  files: File[];
  dispose: () => void;
}
