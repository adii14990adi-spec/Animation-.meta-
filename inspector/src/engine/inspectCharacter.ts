import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  basenamePosix,
  COMPONENT_TYPE_NAMES,
  decodeDataUri,
  dirnamePosix,
  getFileRelativePath,
  inspectImageBytes,
  normalizePosixPath,
  readGltfAccessor,
  resolveUploadedResource,
  type GltfJson,
} from './gltfBinaryUtils';
import { analyzeHumanoidStructure, detectRigNamingScheme } from './humanoidAnalyzer';
import type {
  BindPoseStatus,
  BindPoseValidationSummary,
  BoneHierarchyStatus,
  BoneHierarchyTreeNode,
  BoneNodeReport,
  BoneWeightsStatus,
  BufferValidationItem,
  CharacterInspectionReport,
  CharacterSlotId,
  FinalClassification,
  InspectionIssue,
  LicenceInfo,
  LoadedCharacterSession,
  MeshPrimitiveSkinningReport,
  SkeletonReport,
  SkeletonStatus,
  SkinnedMeshStatus,
  SkinningValidationSummary,
  TexturesStatus,
  TextureValidationItem,
  UploadedFileEntry,
  UploadedFileRole,
} from './types';

const FALLBACK_PREVIEW_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const LIMITATIONS_NOTICE: string[] = [
  'Phase 1 Browser Structural Inspection Only: animation playback, retargeting, and auto-rigging are intentionally out of scope.',
  'This web application is NOT the Unity Editor and does NOT run Unity AvatarBuilder, Mecanim muscle setup, or Unity runtime verification.',
  'Humanoid bone matches ("Found", "Possible match", "Ambiguous", "Missing") are heuristic analyses of bone names and hierarchy, not a guarantee of Unity Humanoid compatibility.',
  'All uploaded files (.gltf, .bin, textures, licence.txt) are inspected locally in browser memory and are never modified, committed, or sent to external servers.',
];

function classifyUploadedFileRole(file: File): UploadedFileRole {
  const lower = basenamePosix(getFileRelativePath(file)).toLowerCase();
  if (lower.endsWith('.gltf')) return 'gltf';
  if (lower.endsWith('.bin')) return 'bin';
  if (/^licen[cs]e.*\.txt$/i.test(lower)) {
    return 'licence';
  }
  if (/\.(png|jpe?g|webp|gif|bmp|ktx2|tga|dds)$/i.test(lower)) {
    return 'texture';
  }
  return 'other';
}

function detectUnusualBoneName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Bone has an empty name string.';
  }
  if (/^\d+$/.test(trimmed)) {
    return 'Numeric-only bone name without anatomical identifier.';
  }
  if (/\$AssimpFbx\$/i.test(trimmed)) {
    return 'Assimp FBX split transform helper node ($AssimpFbx$) included as a skin joint.';
  }
  if (/(?:^|[_.\-])leaf(?:$|[_.\-])/i.test(trimmed)) {
    return 'Blender glTF exporter leaf end-bone (*_leaf*); non-deforming tip joint.';
  }
  if (/_end$|\.00\d+$|_nub$/i.test(trimmed) && /^bone/i.test(trimmed)) {
    return 'Generic auto-numbered bone / leaf nub name (e.g., Bone.001 / _end).';
  }
  if (/^(node_\d+|joint_\d+|object_\d+)$/i.test(trimmed)) {
    return 'Auto-generated unnamed node identifier.';
  }
  if (/^(cube|sphere|cylinder|plane|icosphere|mesh)(?:[._]\d+)?$/i.test(trimmed)) {
    return 'Primitive mesh name used inside skeleton joints.';
  }
  return null;
}

function disposeThreeScene(root: THREE.Object3D | null): void {
  if (!root) return;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const mat = mesh.material;
    const disposeMaterial = (m: THREE.Material) => {
      for (const value of Object.values(m)) {
        if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) {
          (value as THREE.Texture).dispose();
        }
      }
      m.dispose();
    };
    if (Array.isArray(mat)) {
      mat.forEach(disposeMaterial);
    } else if (mat) {
      disposeMaterial(mat);
    }
  });
}

async function readLicenceSummary(files: File[]): Promise<LicenceInfo> {
  const licenceFile = files.find((f) => classifyUploadedFileRole(f) === 'licence');
  if (!licenceFile) {
    return {
      present: false,
      fileName: null,
      sizeBytes: 0,
      lineCount: 0,
      summaryNote: 'No licence.txt uploaded in character bundle (optional companion file).',
    };
  }
  const text =
    typeof licenceFile.text === 'function'
      ? await licenceFile.text()
      : new TextDecoder().decode(await licenceFile.arrayBuffer());
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const fileName = basenamePosix(getFileRelativePath(licenceFile));
  return {
    present: true,
    fileName,
    sizeBytes: licenceFile.size,
    lineCount: lines.length,
    summaryNote: `Companion license file "${fileName}" verified (${licenceFile.size.toLocaleString()} bytes, ${lines.length} non-empty line${lines.length === 1 ? '' : 's'}). Kept private in local session.`,
  };
}

function createEmptyFailureSession(
  slot: CharacterSlotId,
  sourceLabel: string,
  files: File[],
  uploadedFiles: UploadedFileEntry[],
  licence: LicenceInfo,
  issues: InspectionIssue[],
  primaryGltfFileName: string | null = null,
  buffers: BufferValidationItem[] = [],
  textures: TextureValidationItem[] = [],
  assetMeta?: CharacterInspectionReport['gltfAssetMetadata'],
): LoadedCharacterSession {
  const slotLabel = slot === 'male' ? 'Male Character' : 'Female Character';
  const emptyHumanoid = analyzeHumanoidStructure([]);

  const texturesStatus: TexturesStatus =
    textures.some((t) => t.status === 'missing')
      ? 'Missing'
      : textures.some((t) => t.status === 'failed')
        ? 'Failed'
        : 'Loaded';

  const report: CharacterInspectionReport = {
    schemaVersion: '1.0.0',
    phase: 'Phase 1 — Browser Structural Inspection Only',
    slot,
    slotLabel,
    inspectedAtIso: new Date().toISOString(),
    primaryGltfFileName,
    gltfAssetMetadata: assetMeta ?? {
      version: null,
      generator: null,
      copyright: null,
      minVersion: null,
    },
    finalClassification: 'INVALID_OR_INCOMPLETE_GLTF',
    statuses: {
      skeleton: 'Missing',
      skinnedMesh: 'Missing',
      boneWeights: 'Missing',
      boneHierarchy: 'Issues Found',
      bindPose: 'Missing',
      humanoidStructure: 'Unknown',
      textures: texturesStatus,
    },
    uploadedFiles,
    licence,
    buffers,
    textures,
    sceneSummary: {
      gltfSkinCount: 0,
      threeSkeletonCount: 0,
      threeSkinnedMeshCount: 0,
      threeStaticMeshCount: 0,
      totalSceneNodes: 0,
      allMeshesConnectedToSkeleton: false,
    },
    skeletons: [],
    skinning: {
      status: 'Missing',
      totalMeshInstances: 0,
      skinnedMeshCount: 0,
      nonSkinnedMeshCount: 0,
      disconnectedSkinAttributeMeshCount: 0,
      meshAndSkeletonConsistent: false,
      totalSkinnedVerticesInspected: 0,
      negativeWeightVertices: 0,
      nonFiniteWeightVertices: 0,
      zeroInfluenceVertices: 0,
      unnormalizedVertices: 0,
      outOfRangeJointVertices: 0,
      requiresWeightNormalization: false,
      primitives: [],
    },
    bindPose: {
      status: 'Missing',
      hasExplicitInverseBindMatrices: false,
      ibmAccessorCountMatchesJoints: false,
      totalMatricesChecked: 0,
      nonFiniteMatrixCount: 0,
      singularNonInvertibleMatrixCount: 0,
      negativeDeterminantMatrixCount: 0,
      invalidRestTransformBoneCount: 0,
      bindBoundsMin: null,
      bindBoundsMax: null,
      estimatedRigHeight: null,
      detectedNamingConvention: 'None',
      mixamoNamingDetected: false,
      notes: ['GLTF bundle could not be loaded completely due to invalid or missing required files.'],
    },
    humanoid: emptyHumanoid,
    confirmedFacts: issues
      .filter((i) => i.basis === 'confirmed_fact')
      .map((i) => i.message),
    heuristicFindings: [],
    issues,
    limitationsNotice: LIMITATIONS_NOTICE,
  };

  return {
    slot,
    sourceLabel,
    report,
    sceneRoot: null,
    skeletonBonesByJointKey: new Map(),
    files,
    dispose: () => {},
  };
}

async function loadWithThreeGltfLoader(
  rawGltfText: string,
  gltfDir: string,
  files: File[],
  missingOrFailedImageUris: Set<string>,
): Promise<{ gltf: GLTF; revokeUrls: () => void }> {
  const objectUrls: string[] = [];
  const urlCache = new Map<File, string>();

  const getOrCreateBlobUrl = (file: File): string => {
    const existing = urlCache.get(file);
    if (existing) return existing;
    const created = URL.createObjectURL(file);
    objectUrls.push(created);
    urlCache.set(file, created);
    return created;
  };

  const revokeUrls = () => {
    while (objectUrls.length > 0) {
      const u = objectUrls.pop();
      if (u) URL.revokeObjectURL(u);
    }
    urlCache.clear();
  };

  const isJsdom =
    typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent ?? '');

  if (isJsdom) {
    const parsedCopy = JSON.parse(rawGltfText) as GltfJson;
    const uint8ToBase64 = (bytes: Uint8Array): string => {
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    };

    if (Array.isArray(parsedCopy.buffers)) {
      for (const buf of parsedCopy.buffers) {
        if (buf.uri && !buf.uri.startsWith('data:')) {
          const resolved = resolveUploadedResource(buf.uri, gltfDir, files);
          if (resolved.file) {
            const bytes = new Uint8Array(await resolved.file.arrayBuffer());
            buf.uri = `data:application/octet-stream;base64,${uint8ToBase64(bytes)}`;
          }
        }
      }
    }

    if (Array.isArray(parsedCopy.images)) {
      for (const img of parsedCopy.images) {
        if (img.uri) {
          img.uri = FALLBACK_PREVIEW_PNG_DATA_URI;
        }
      }
    }

    const manager = new THREE.LoadingManager();
    class InstantDataTextureLoader extends THREE.Loader<THREE.DataTexture> {
      override load(
        _url: string,
        onLoad?: (data: THREE.DataTexture) => void,
      ): THREE.DataTexture {
        const tex = new THREE.DataTexture(new Uint8Array([200, 205, 212, 255]), 1, 1);
        tex.needsUpdate = true;
        if (onLoad) queueMicrotask(() => onLoad(tex));
        return tex;
      }
    }
    manager.addHandler(
      /^data:image\/|\.(png|jpe?g|webp|gif|bmp|ktx2)$/i,
      new InstantDataTextureLoader(manager),
    );

    const loader = new GLTFLoader(manager);
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(JSON.stringify(parsedCopy), '', resolve, (err) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
    });
    return { gltf, revokeUrls };
  }

  const SENTINEL_PREFIX = '__UPLOADED_BUNDLE__/';
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((requestedUrl: string) => {
    if (requestedUrl.startsWith('data:') || requestedUrl.startsWith('blob:')) {
      return requestedUrl;
    }

    let relUri = requestedUrl;
    const markerIdx = requestedUrl.indexOf(SENTINEL_PREFIX);
    if (markerIdx !== -1) {
      relUri = requestedUrl.slice(markerIdx + SENTINEL_PREFIX.length);
    }

    const normalizedUri = normalizePosixPath(relUri);
    if (
      missingOrFailedImageUris.has(normalizedUri) ||
      missingOrFailedImageUris.has(relUri)
    ) {
      return FALLBACK_PREVIEW_PNG_DATA_URI;
    }

    const resolved = resolveUploadedResource(relUri, gltfDir, files);
    if (resolved.file) {
      return getOrCreateBlobUrl(resolved.file);
    }

    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(relUri)) {
      return FALLBACK_PREVIEW_PNG_DATA_URI;
    }

    return requestedUrl;
  });

  const loader = new GLTFLoader(manager);
  try {
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(rawGltfText, SENTINEL_PREFIX, resolve, (err) => {
        revokeUrls();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    revokeUrls();
    return { gltf, revokeUrls };
  } catch (err) {
    revokeUrls();
    throw err;
  }
}

export async function inspectCharacterBundle(
  inputFiles: File[],
  slot: CharacterSlotId,
  sourceLabel = 'Local Browser Upload',
): Promise<LoadedCharacterSession> {
  const files = [...inputFiles];
  const slotLabel = slot === 'male' ? 'Male Character' : 'Female Character';
  const uploadedFiles: UploadedFileEntry[] = files.map((file) => ({
    name: basenamePosix(getFileRelativePath(file)),
    relativePath: getFileRelativePath(file),
    sizeBytes: file.size,
    role: classifyUploadedFileRole(file),
  }));

  const licence = await readLicenceSummary(files);
  const issues: InspectionIssue[] = [];
  const confirmedFacts: string[] = [];
  const heuristicFindings: string[] = [];

  if (files.length === 0) {
    issues.push({
      severity: 'error',
      code: 'NO_FILES_UPLOADED',
      title: 'No Files Selected',
      message: `No character files were selected for ${slotLabel}. Select a .gltf file together with its .bin buffer and any external textures.`,
      category: 'package',
      basis: 'confirmed_fact',
    });
    return createEmptyFailureSession(
      slot,
      sourceLabel,
      files,
      uploadedFiles,
      licence,
      issues,
    );
  }

  const gltfFiles = files.filter((f) => classifyUploadedFileRole(f) === 'gltf');
  const glbFiles = files.filter((f) =>
    basenamePosix(getFileRelativePath(f)).toLowerCase().endsWith('.glb'),
  );

  if (gltfFiles.length === 0) {
    if (glbFiles.length > 0) {
      issues.push({
        severity: 'error',
        code: 'GLB_NOT_SUPPORTED_IN_PHASE_1',
        title: 'Binary .glb Uploaded Instead of .gltf + .bin',
        message: `Uploaded "${glbFiles[0].name}", but Phase 1 requires unpacked ".gltf + .bin" character packages (plus optional external textures and licence.txt).`,
        category: 'package',
        basis: 'confirmed_fact',
      });
    } else {
      issues.push({
        severity: 'error',
        code: 'MISSING_GLTF_FILE',
        title: 'Missing .gltf Scene File',
        message: `Selected ${files.length} file(s), none with a ".gltf" extension. Include the character's .gltf descriptor file alongside its .bin file.`,
        category: 'package',
        basis: 'confirmed_fact',
      });
    }
    return createEmptyFailureSession(
      slot,
      sourceLabel,
      files,
      uploadedFiles,
      licence,
      issues,
    );
  }

  if (gltfFiles.length > 1) {
    issues.push({
      severity: 'error',
      code: 'MULTIPLE_GLTF_FILES_IN_SLOT',
      title: 'Multiple .gltf Files in Single Character Slot',
      message: `Found ${gltfFiles.length} .gltf files (${gltfFiles.map((f) => f.name).join(', ')}) in ${slotLabel}. Upload one character (.gltf + its .bin + textures) per slot.`,
      category: 'package',
      basis: 'confirmed_fact',
    });
    return createEmptyFailureSession(
      slot,
      sourceLabel,
      files,
      uploadedFiles,
      licence,
      issues,
      gltfFiles[0].name,
    );
  }

  const primaryGltfFile = gltfFiles[0];
  const primaryGltfRelPath = getFileRelativePath(primaryGltfFile);
  const primaryGltfName = basenamePosix(primaryGltfRelPath);
  const gltfDir = dirnamePosix(primaryGltfRelPath);

  let rawGltfText = '';
  try {
    rawGltfText = await primaryGltfFile.text();
  } catch (err) {
    issues.push({
      severity: 'error',
      code: 'GLTF_READ_ERROR',
      title: 'Failed to Read .gltf File',
      message: `Browser failed to read "${primaryGltfName}": ${err instanceof Error ? err.message : String(err)}`,
      category: 'gltf_json',
      basis: 'confirmed_fact',
    });
    return createEmptyFailureSession(
      slot,
      sourceLabel,
      files,
      uploadedFiles,
      licence,
      issues,
      primaryGltfName,
    );
  }

  let gltfJson: GltfJson;
  try {
    const parsed = JSON.parse(rawGltfText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Root JSON value must be an object.');
    }
    gltfJson = parsed as GltfJson;
  } catch (err) {
    issues.push({
      severity: 'error',
      code: 'INVALID_GLTF_JSON',
      title: 'Invalid JSON in .gltf File',
      message: `"${primaryGltfName}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      category: 'gltf_json',
      basis: 'confirmed_fact',
    });
    return createEmptyFailureSession(
      slot,
      sourceLabel,
      files,
      uploadedFiles,
      licence,
      issues,
      primaryGltfName,
    );
  }

  const assetMeta = {
    version: typeof gltfJson.asset?.version === 'string' ? gltfJson.asset.version : null,
    generator:
      typeof gltfJson.asset?.generator === 'string' ? gltfJson.asset.generator : null,
    copyright:
      typeof gltfJson.asset?.copyright === 'string' ? gltfJson.asset.copyright : null,
    minVersion:
      typeof gltfJson.asset?.minVersion === 'string' ? gltfJson.asset.minVersion : null,
  };

  if (!assetMeta.version || !assetMeta.version.startsWith('2.')) {
    issues.push({
      severity: 'error',
      code: 'UNSUPPORTED_GLTF_VERSION',
      title: 'Invalid or Unsupported glTF Version',
      message: `"${primaryGltfName}" declares asset.version="${String(assetMeta.version ?? 'missing')}". Expected glTF 2.0 ("2.0").`,
      category: 'gltf_json',
      basis: 'confirmed_fact',
    });
    return createEmptyFailureSession(
      slot,
      sourceLabel,
      files,
      uploadedFiles,
      licence,
      issues,
      primaryGltfName,
      [],
      [],
      assetMeta,
    );
  }

  confirmedFacts.push(
    `Parsed valid glTF ${assetMeta.version} JSON "${primaryGltfName}" (${primaryGltfFile.size.toLocaleString()} bytes${assetMeta.generator ? `, generator: ${assetMeta.generator}` : ''}).`,
  );

  // 1. Validate BIN / embedded buffers
  const bufferReports: BufferValidationItem[] = [];
  const loadedBuffers = new Map<number, Uint8Array>();
  let hasFatalBufferError = false;

  const rawBuffers = gltfJson.buffers ?? [];
  for (let i = 0; i < rawBuffers.length; i++) {
    const bufDef = rawBuffers[i];
    const declaredLen = typeof bufDef.byteLength === 'number' ? bufDef.byteLength : -1;
    const uri = typeof bufDef.uri === 'string' ? bufDef.uri : null;

    if (declaredLen < 0) {
      hasFatalBufferError = true;
      const errMsg = `Buffer #${i} has missing or negative byteLength.`;
      bufferReports.push({
        bufferIndex: i,
        uri,
        isEmbeddedDataUri: false,
        declaredByteLength: declaredLen,
        actualByteLength: null,
        resolvedFileName: null,
        resolutionMode: 'missing',
        status: 'invalid',
        error: errMsg,
      });
      issues.push({
        severity: 'error',
        code: 'INVALID_BUFFER_DEFINITION',
        title: 'Invalid GLTF Buffer Definition',
        message: errMsg,
        category: 'buffers',
        basis: 'confirmed_fact',
      });
      continue;
    }

    if (!uri) {
      hasFatalBufferError = true;
      const errMsg = `Buffer #${i} has no URI (GLB binary chunk reference inside a .gltf file). Upload the external .bin file referenced by a valid .gltf.`;
      bufferReports.push({
        bufferIndex: i,
        uri: null,
        isEmbeddedDataUri: false,
        declaredByteLength: declaredLen,
        actualByteLength: null,
        resolvedFileName: null,
        resolutionMode: 'missing',
        status: 'missing',
        error: errMsg,
      });
      issues.push({
        severity: 'error',
        code: 'MISSING_BIN_URI',
        title: 'Buffer Missing External .bin URI',
        message: errMsg,
        category: 'buffers',
        basis: 'confirmed_fact',
      });
      continue;
    }

    if (uri.startsWith('data:')) {
      try {
        const { bytes } = decodeDataUri(uri);
        if (bytes.byteLength < declaredLen) {
          hasFatalBufferError = true;
          const errMsg = `Embedded data URI buffer #${i} is truncated (${bytes.byteLength} bytes < declared ${declaredLen} bytes).`;
          bufferReports.push({
            bufferIndex: i,
            uri: 'data:application/octet-stream;...',
            isEmbeddedDataUri: true,
            declaredByteLength: declaredLen,
            actualByteLength: bytes.byteLength,
            resolvedFileName: '(embedded data URI)',
            resolutionMode: 'embedded_data_uri',
            status: 'truncated',
            error: errMsg,
          });
          issues.push({
            severity: 'error',
            code: 'TRUNCATED_BIN_BUFFER',
            title: 'Truncated Binary Buffer',
            message: errMsg,
            category: 'buffers',
            basis: 'confirmed_fact',
          });
        } else {
          loadedBuffers.set(i, bytes);
          bufferReports.push({
            bufferIndex: i,
            uri: 'data:application/octet-stream;...',
            isEmbeddedDataUri: true,
            declaredByteLength: declaredLen,
            actualByteLength: bytes.byteLength,
            resolvedFileName: '(embedded data URI)',
            resolutionMode: 'embedded_data_uri',
            status: 'valid',
            error: null,
          });
        }
      } catch (err) {
        hasFatalBufferError = true;
        const errMsg = `Buffer #${i} embedded data URI failed to decode: ${err instanceof Error ? err.message : String(err)}`;
        bufferReports.push({
          bufferIndex: i,
          uri: 'data:...',
          isEmbeddedDataUri: true,
          declaredByteLength: declaredLen,
          actualByteLength: null,
          resolvedFileName: null,
          resolutionMode: 'embedded_data_uri',
          status: 'invalid',
          error: errMsg,
        });
        issues.push({
          severity: 'error',
          code: 'INVALID_DATA_URI_BUFFER',
          title: 'Corrupt Embedded Buffer Data URI',
          message: errMsg,
          category: 'buffers',
          basis: 'confirmed_fact',
        });
      }
      continue;
    }

    const resolved = resolveUploadedResource(uri, gltfDir, files);
    if (!resolved.file) {
      hasFatalBufferError = true;
      const ambigDetail = resolved.ambiguousNames
        ? ` Multiple files shared the same filename (${resolved.ambiguousNames.join(', ')}).`
        : '';
      const errMsg = `Missing required binary buffer "${uri}" referenced by "${primaryGltfName}" (declared ${declaredLen.toLocaleString()} bytes). Select "${basenamePosix(uri)}" together with "${primaryGltfName}".${ambigDetail}`;
      bufferReports.push({
        bufferIndex: i,
        uri,
        isEmbeddedDataUri: false,
        declaredByteLength: declaredLen,
        actualByteLength: null,
        resolvedFileName: null,
        resolutionMode: 'missing',
        status: 'missing',
        error: errMsg,
      });
      issues.push({
        severity: 'error',
        code: 'MISSING_BIN_FILE',
        title: 'Missing .bin Buffer File',
        message: errMsg,
        category: 'buffers',
        basis: 'confirmed_fact',
      });
      continue;
    }

    const bytes = new Uint8Array(await resolved.file.arrayBuffer());
    if (bytes.byteLength < declaredLen) {
      hasFatalBufferError = true;
      const errMsg = `Binary buffer "${resolved.file.name}" (${bytes.byteLength.toLocaleString()} bytes) is smaller than glTF declared byteLength (${declaredLen.toLocaleString()} bytes).`;
      bufferReports.push({
        bufferIndex: i,
        uri,
        isEmbeddedDataUri: false,
        declaredByteLength: declaredLen,
        actualByteLength: bytes.byteLength,
        resolvedFileName: resolved.file.name,
        resolutionMode: resolved.mode,
        status: 'truncated',
        error: errMsg,
      });
      issues.push({
        severity: 'error',
        code: 'TRUNCATED_BIN_FILE',
        title: 'Truncated .bin Buffer File',
        message: errMsg,
        category: 'buffers',
        basis: 'confirmed_fact',
      });
      continue;
    }

    loadedBuffers.set(i, bytes);
    bufferReports.push({
      bufferIndex: i,
      uri,
      isEmbeddedDataUri: false,
      declaredByteLength: declaredLen,
      actualByteLength: bytes.byteLength,
      resolvedFileName: resolved.file.name,
      resolutionMode: resolved.mode,
      status: 'valid',
      error: null,
    });
    confirmedFacts.push(
      `Resolved binary buffer #${i} "${uri}" -> "${resolved.file.name}" (${bytes.byteLength.toLocaleString()} bytes).`,
    );
  }

  // 2. Validate external / bufferView / data-URI textures
  const textureReports: TextureValidationItem[] = [];
  const missingOrFailedImageUris = new Set<string>();
  const rawImages = gltfJson.images ?? [];

  for (let i = 0; i < rawImages.length; i++) {
    const imgDef = rawImages[i];
    const label = imgDef.name || (imgDef.uri ? basenamePosix(imgDef.uri) : `Image #${i}`);

    if (typeof imgDef.uri === 'string') {
      if (imgDef.uri.startsWith('data:')) {
        try {
          const { bytes, mimeType } = decodeDataUri(imgDef.uri);
          const check = inspectImageBytes(bytes);
          if (!check.valid) {
            missingOrFailedImageUris.add(imgDef.uri);
            const errMsg = `Embedded image #${i} ("${label}") failed binary validation: ${check.error ?? 'corrupt image bytes'}`;
            textureReports.push({
              imageIndex: i,
              name: label,
              uri: 'data:image/...',
              sourceKind: 'embedded_data_uri',
              mimeType: imgDef.mimeType ?? mimeType,
              resolvedFileName: '(embedded data URI)',
              resolutionMode: 'embedded',
              sizeBytes: bytes.byteLength,
              dimensions:
                check.width && check.height
                  ? { width: check.width, height: check.height }
                  : null,
              status: 'failed',
              error: errMsg,
            });
            issues.push({
              severity: 'error',
              code: 'CORRUPT_EMBEDDED_TEXTURE',
              title: 'Embedded Texture Decode Failed',
              message: errMsg,
              category: 'textures',
              basis: 'confirmed_fact',
            });
          } else {
            textureReports.push({
              imageIndex: i,
              name: label,
              uri: 'data:image/...',
              sourceKind: 'embedded_data_uri',
              mimeType: imgDef.mimeType ?? mimeType,
              resolvedFileName: '(embedded data URI)',
              resolutionMode: 'embedded',
              sizeBytes: bytes.byteLength,
              dimensions:
                check.width && check.height
                  ? { width: check.width, height: check.height }
                  : null,
              status: 'loaded',
              error: null,
            });
          }
        } catch (err) {
          missingOrFailedImageUris.add(imgDef.uri);
          const errMsg = `Embedded image #${i} data URI is malformed: ${err instanceof Error ? err.message : String(err)}`;
          textureReports.push({
            imageIndex: i,
            name: label,
            uri: 'data:...',
            sourceKind: 'embedded_data_uri',
            mimeType: imgDef.mimeType ?? null,
            resolvedFileName: null,
            resolutionMode: 'embedded',
            sizeBytes: null,
            dimensions: null,
            status: 'failed',
            error: errMsg,
          });
          issues.push({
            severity: 'error',
            code: 'INVALID_TEXTURE_DATA_URI',
            title: 'Invalid Texture Data URI',
            message: errMsg,
            category: 'textures',
            basis: 'confirmed_fact',
          });
        }
      } else {
        const resolved = resolveUploadedResource(imgDef.uri, gltfDir, files);
        if (!resolved.file) {
          missingOrFailedImageUris.add(imgDef.uri);
          missingOrFailedImageUris.add(normalizePosixPath(imgDef.uri));
          const ambigNote = resolved.ambiguousNames
            ? ` Ambiguous duplicate filenames found: ${resolved.ambiguousNames.join(', ')}.`
            : '';
          const errMsg = `Missing external texture "${imgDef.uri}" referenced by glTF image #${i} ("${label}"). Select "${basenamePosix(imgDef.uri)}" with the character files to display this material map.${ambigNote}`;
          textureReports.push({
            imageIndex: i,
            name: label,
            uri: imgDef.uri,
            sourceKind: 'external_uri',
            mimeType: imgDef.mimeType ?? null,
            resolvedFileName: null,
            resolutionMode: 'missing',
            sizeBytes: null,
            dimensions: null,
            status: 'missing',
            error: errMsg,
          });
          issues.push({
            severity: 'error',
            code: 'MISSING_EXTERNAL_TEXTURE',
            title: 'Missing External Texture File',
            message: errMsg,
            category: 'textures',
            basis: 'confirmed_fact',
          });
        } else {
          const imgBytes = new Uint8Array(await resolved.file.arrayBuffer());
          const check = inspectImageBytes(imgBytes);
          if (!check.valid) {
            missingOrFailedImageUris.add(imgDef.uri);
            missingOrFailedImageUris.add(normalizePosixPath(imgDef.uri));
            const errMsg = `External texture "${resolved.file.name}" (referenced as "${imgDef.uri}") failed image header validation: ${check.error ?? 'corrupt image'}`;
            textureReports.push({
              imageIndex: i,
              name: label,
              uri: imgDef.uri,
              sourceKind: 'external_uri',
              mimeType: imgDef.mimeType ?? null,
              resolvedFileName: resolved.file.name,
              resolutionMode: resolved.mode,
              sizeBytes: imgBytes.byteLength,
              dimensions: null,
              status: 'failed',
              error: errMsg,
            });
            issues.push({
              severity: 'error',
              code: 'INVALID_EXTERNAL_TEXTURE',
              title: 'External Texture Failed to Load',
              message: errMsg,
              category: 'textures',
              basis: 'confirmed_fact',
            });
          } else {
            textureReports.push({
              imageIndex: i,
              name: label,
              uri: imgDef.uri,
              sourceKind: 'external_uri',
              mimeType: imgDef.mimeType ?? (check.format ? `image/${check.format}` : null),
              resolvedFileName: resolved.file.name,
              resolutionMode: resolved.mode,
              sizeBytes: imgBytes.byteLength,
              dimensions:
                check.width && check.height
                  ? { width: check.width, height: check.height }
                  : null,
              status: 'loaded',
              error: null,
            });
            if (resolved.mode === 'basename_fallback') {
              issues.push({
                severity: 'info',
                code: 'TEXTURE_RESOLVED_BY_BASENAME',
                title: 'External Texture Matched by Filename',
                message: `Texture "${imgDef.uri}" resolved to flat-selected file "${resolved.file.name}".`,
                category: 'textures',
                basis: 'confirmed_fact',
              });
            }
          }
        }
      }
    } else if (typeof imgDef.bufferView === 'number') {
      const bvs = gltfJson.bufferViews ?? [];
      const bv = bvs[imgDef.bufferView];
      const buf = bv ? loadedBuffers.get(bv.buffer) : undefined;
      if (!bv || !buf || (bv.byteOffset ?? 0) + bv.byteLength > buf.byteLength) {
        const errMsg = `BufferView-backed image #${i} ("${label}") references invalid or unavailable bufferView #${imgDef.bufferView}.`;
        textureReports.push({
          imageIndex: i,
          name: label,
          uri: null,
          sourceKind: 'buffer_view',
          mimeType: imgDef.mimeType ?? null,
          resolvedFileName: `bufferView #${imgDef.bufferView}`,
          resolutionMode: 'embedded',
          sizeBytes: null,
          dimensions: null,
          status: hasFatalBufferError ? 'missing' : 'failed',
          error: errMsg,
        });
        if (!hasFatalBufferError) {
          issues.push({
            severity: 'error',
            code: 'INVALID_BUFFERVIEW_TEXTURE',
            title: 'BufferView Image Invalid',
            message: errMsg,
            category: 'textures',
            basis: 'confirmed_fact',
          });
        }
      } else {
        const slice = buf.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
        const check = inspectImageBytes(slice);
        textureReports.push({
          imageIndex: i,
          name: label,
          uri: null,
          sourceKind: 'buffer_view',
          mimeType: imgDef.mimeType ?? (check.format ? `image/${check.format}` : null),
          resolvedFileName: `bufferView #${imgDef.bufferView}`,
          resolutionMode: 'embedded',
          sizeBytes: slice.byteLength,
          dimensions:
            check.width && check.height ? { width: check.width, height: check.height } : null,
          status: check.valid ? 'loaded' : 'failed',
          error: check.valid ? null : check.error,
        });
        if (!check.valid) {
          issues.push({
            severity: 'error',
            code: 'CORRUPT_BUFFERVIEW_TEXTURE',
            title: 'BufferView Texture Corrupt',
            message: `Image #${i} in bufferView #${imgDef.bufferView} failed header check: ${check.error ?? 'corrupt'}`,
            category: 'textures',
            basis: 'confirmed_fact',
          });
        }
      }
    }
  }

  if (hasFatalBufferError) {
    return createEmptyFailureSession(
      slot,
      sourceLabel,
      files,
      uploadedFiles,
      licence,
      issues,
      primaryGltfName,
      bufferReports,
      textureReports,
      assetMeta,
    );
  }

  // 3. Load scene through Three.js GLTFLoader
  let loadedGltf: GLTF;
  let revokeLoaderUrls: () => void = () => {};
  try {
    const loaded = await loadWithThreeGltfLoader(
      rawGltfText,
      gltfDir,
      files,
      missingOrFailedImageUris,
    );
    loadedGltf = loaded.gltf;
    revokeLoaderUrls = loaded.revokeUrls;
  } catch (err) {
    issues.push({
      severity: 'error',
      code: 'THREE_GLTFLOADER_ERROR',
      title: 'Three.js GLTFLoader Failed to Parse Scene',
      message: `Three.js GLTFLoader could not instantiate "${primaryGltfName}": ${err instanceof Error ? err.message : String(err)}`,
      category: 'gltf_json',
      basis: 'confirmed_fact',
    });
    return createEmptyFailureSession(
      slot,
      sourceLabel,
      files,
      uploadedFiles,
      licence,
      issues,
      primaryGltfName,
      bufferReports,
      textureReports,
      assetMeta,
    );
  }

  const sceneRoot = loadedGltf.scene;
  sceneRoot.updateMatrixWorld(true);

  const threeSkinnedMeshes: THREE.SkinnedMesh[] = [];
  const threeStaticMeshes: THREE.Mesh[] = [];
  const uniqueThreeSkeletons = new Set<THREE.Skeleton>();
  const allThreeBones: THREE.Bone[] = [];
  let totalSceneNodes = 0;

  sceneRoot.traverse((obj) => {
    totalSceneNodes++;
    if ((obj as THREE.Bone).isBone) {
      allThreeBones.push(obj as THREE.Bone);
    }
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
      const sm = obj as THREE.SkinnedMesh;
      threeSkinnedMeshes.push(sm);
      if (sm.skeleton) {
        uniqueThreeSkeletons.add(sm.skeleton);
      }
    } else if ((obj as THREE.Mesh).isMesh) {
      threeStaticMeshes.push(obj as THREE.Mesh);
    }
  });

  // 4. Inspect GLTF Nodes, Skins, Bone Hierarchy & Bind Pose
  const rawNodes = gltfJson.nodes ?? [];
  const rawSkins = gltfJson.skins ?? [];
  const nodeParentMap = new Map<number, number>();
  let brokenChildRef = false;

  for (let nIdx = 0; nIdx < rawNodes.length; nIdx++) {
    const children = rawNodes[nIdx]?.children ?? [];
    for (const cIdx of children) {
      if (cIdx < 0 || cIdx >= rawNodes.length) {
        brokenChildRef = true;
        issues.push({
          severity: 'error',
          code: 'INVALID_NODE_CHILD_INDEX',
          title: 'Out-of-Range Node Child Reference',
          message: `Node #${nIdx} references nonexistent child node #${cIdx}.`,
          category: 'hierarchy',
          basis: 'confirmed_fact',
        });
        continue;
      }
      if (nodeParentMap.has(cIdx)) {
        brokenChildRef = true;
        issues.push({
          severity: 'error',
          code: 'DAG_SHARED_CHILD_NODE',
          title: 'Invalid Non-Tree Node Hierarchy',
          message: `Node #${cIdx} has multiple parent nodes (#${nodeParentMap.get(cIdx)} and #${nIdx}), violating glTF strict tree hierarchy.`,
          category: 'hierarchy',
          basis: 'confirmed_fact',
        });
      }
      nodeParentMap.set(cIdx, nIdx);
    }
  }

  const skinnedMeshNamesBySkinIndex = new Map<number, string[]>();
  for (let nIdx = 0; nIdx < rawNodes.length; nIdx++) {
    const node = rawNodes[nIdx];
    if (node.skin !== undefined && node.mesh !== undefined) {
      const list = skinnedMeshNamesBySkinIndex.get(node.skin) ?? [];
      const mName = gltfJson.meshes?.[node.mesh]?.name || node.name || `Mesh #${node.mesh}`;
      list.push(mName);
      skinnedMeshNamesBySkinIndex.set(node.skin, list);
    }
  }

  const skeletonReports: SkeletonReport[] = [];
  const skeletonBonesByJointKey = new Map<string, THREE.Bone>();

  let anyExplicitIbm = false;
  let allIbmCountsMatch = true;
  let totalIbmMatricesChecked = 0;
  let nonFiniteMatrixCount = 0;
  let singularMatrixCount = 0;
  let negativeDetMatrixCount = 0;
  let invalidRestTransformCount = 0;
  let bindMinX = Infinity;
  let bindMinY = Infinity;
  let bindMinZ = Infinity;
  let bindMaxX = -Infinity;
  let bindMaxY = -Infinity;
  let bindMaxZ = -Infinity;
  const bindNotes: string[] = [];

  const threeSkeletonArray = [...uniqueThreeSkeletons];

  for (let sIdx = 0; sIdx < rawSkins.length; sIdx++) {
    const skinDef = rawSkins[sIdx];
    const joints = skinDef.joints ?? [];
    const jointSet = new Set<number>(joints);
    const gltfNodeToJointIdx = new Map<number, number>();
    joints.forEach((nIdx, jIdx) => gltfNodeToJointIdx.set(nIdx, jIdx));

    let ibmDecodedValues: Float64Array | null = null;
    if (skinDef.inverseBindMatrices !== undefined) {
      anyExplicitIbm = true;
      try {
        const acc = readGltfAccessor(gltfJson, skinDef.inverseBindMatrices, loadedBuffers);
        if (acc.type !== 'MAT4' || acc.componentType !== 5126) {
          allIbmCountsMatch = false;
          issues.push({
            severity: 'error',
            code: 'INVALID_IBM_ACCESSOR_TYPE',
            title: 'Invalid Inverse Bind Matrices Format',
            message: `Skin #${sIdx} inverseBindMatrices accessor #${skinDef.inverseBindMatrices} has type ${acc.type} / componentType ${acc.componentType} (expected MAT4 / FLOAT 5126).`,
            category: 'bind_pose',
            basis: 'confirmed_fact',
          });
        } else if (acc.count !== joints.length) {
          allIbmCountsMatch = false;
          issues.push({
            severity: 'error',
            code: 'IBM_COUNT_MISMATCH',
            title: 'Inverse Bind Matrix Count Mismatch',
            message: `Skin #${sIdx} has ${joints.length} joints, but inverseBindMatrices accessor #${skinDef.inverseBindMatrices} contains ${acc.count} matrices.`,
            category: 'bind_pose',
            basis: 'confirmed_fact',
          });
        } else {
          ibmDecodedValues = acc.values;
        }
      } catch (err) {
        allIbmCountsMatch = false;
        issues.push({
          severity: 'error',
          code: 'IBM_READ_ERROR',
          title: 'Failed to Read Inverse Bind Matrices',
          message: `Skin #${sIdx} inverseBindMatrices accessor could not be read: ${err instanceof Error ? err.message : String(err)}`,
          category: 'bind_pose',
          basis: 'confirmed_fact',
        });
      }
    } else {
      bindNotes.push(
        `Skin #${sIdx} omits inverseBindMatrices accessor (glTF defaults to identity matrices).`,
      );
    }

    const nameOccurrences = new Map<string, number>();
    for (const nIdx of joints) {
      const rawName = (rawNodes[nIdx]?.name ?? '').trim();
      if (rawName.length > 0) {
        nameOccurrences.set(rawName, (nameOccurrences.get(rawName) ?? 0) + 1);
      }
    }
    const duplicateBoneNames = [...nameOccurrences.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name);

    if (duplicateBoneNames.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'DUPLICATE_BONE_NAMES',
        title: 'Duplicate Bone Names Detected',
        message: `Skin #${sIdx} contains duplicate bone names: ${duplicateBoneNames.map((n) => `"${n}"`).join(', ')}. Duplicate joint names can break animation path binding and humanoid mapping.`,
        category: 'hierarchy',
        basis: 'confirmed_fact',
      });
    }

    const bones: BoneNodeReport[] = [];
    const unusualBoneNames: Array<{ name: string; reason: string }> = [];
    let emptyBoneCount = 0;
    let hasCycleOrBroken = brokenChildRef;

    for (let jIdx = 0; jIdx < joints.length; jIdx++) {
      const nIdx = joints[jIdx];
      const nodeDef = rawNodes[nIdx];
      if (!nodeDef) {
        hasCycleOrBroken = true;
        issues.push({
          severity: 'error',
          code: 'INVALID_JOINT_NODE_INDEX',
          title: 'Skin References Missing Node',
          message: `Skin #${sIdx} joint #${jIdx} references out-of-bounds node #${nIdx}.`,
          category: 'hierarchy',
          basis: 'confirmed_fact',
        });
        continue;
      }

      const rawName = typeof nodeDef.name === 'string' ? nodeDef.name : '';
      const trimmedName = rawName.trim();
      const isEmpty = trimmedName.length === 0;
      if (isEmpty) emptyBoneCount++;

      const unusualReason = detectUnusualBoneName(rawName);
      if (unusualReason) {
        unusualBoneNames.push({
          name: isEmpty ? `(unnamed node #${nIdx})` : rawName,
          reason: unusualReason,
        });
      }

      let parentJointIndex: number | null = null;
      const visitedAncestors = new Set<number>([nIdx]);
      let cursorParent = nodeParentMap.get(nIdx);
      while (cursorParent !== undefined) {
        if (visitedAncestors.has(cursorParent)) {
          hasCycleOrBroken = true;
          break;
        }
        visitedAncestors.add(cursorParent);
        if (jointSet.has(cursorParent)) {
          parentJointIndex = gltfNodeToJointIdx.get(cursorParent) ?? null;
          break;
        }
        cursorParent = nodeParentMap.get(cursorParent);
      }

      let restTranslation: [number, number, number] = [0, 0, 0];
      let restRotation: [number, number, number, number] = [0, 0, 0, 1];
      let restScale: [number, number, number] = [1, 1, 1];

      if (Array.isArray(nodeDef.matrix) && nodeDef.matrix.length === 16) {
        const m = new THREE.Matrix4().fromArray(nodeDef.matrix);
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        m.decompose(pos, quat, scl);
        restTranslation = [pos.x, pos.y, pos.z];
        restRotation = [quat.x, quat.y, quat.z, quat.w];
        restScale = [scl.x, scl.y, scl.z];
      } else {
        if (nodeDef.translation) restTranslation = [...nodeDef.translation];
        if (nodeDef.rotation) restRotation = [...nodeDef.rotation];
        if (nodeDef.scale) restScale = [...nodeDef.scale];
      }

      const quatLen = Math.hypot(
        restRotation[0],
        restRotation[1],
        restRotation[2],
        restRotation[3],
      );
      const hasUnitQuaternion =
        Number.isFinite(quatLen) && Math.abs(quatLen - 1.0) <= 0.01;
      const hasValidPositiveScale =
        restScale.every((v) => Number.isFinite(v) && v > 1e-6);

      if (!hasUnitQuaternion || !hasValidPositiveScale) {
        invalidRestTransformCount++;
      }

      let ibmDet: number | null = null;
      let ibmInvertible: boolean | null = null;
      let bindWorldPos: [number, number, number] | null = null;

      if (ibmDecodedValues && (jIdx + 1) * 16 <= ibmDecodedValues.length) {
        totalIbmMatricesChecked++;
        const slice = Array.from(ibmDecodedValues.subarray(jIdx * 16, (jIdx + 1) * 16));
        if (slice.some((v) => !Number.isFinite(v))) {
          nonFiniteMatrixCount++;
          ibmInvertible = false;
        } else {
          const ibmMat = new THREE.Matrix4().fromArray(slice);
          ibmDet = ibmMat.determinant();
          if (Math.abs(ibmDet) <= 1e-8) {
            singularMatrixCount++;
            ibmInvertible = false;
          } else {
            ibmInvertible = true;
            if (ibmDet < 0) {
              negativeDetMatrixCount++;
            }
            const bindMat = ibmMat.clone().invert();
            const bx = bindMat.elements[12];
            const by = bindMat.elements[13];
            const bz = bindMat.elements[14];
            bindWorldPos = [bx, by, bz];
            if (Number.isFinite(bx) && Number.isFinite(by) && Number.isFinite(bz)) {
              bindMinX = Math.min(bindMinX, bx);
              bindMinY = Math.min(bindMinY, by);
              bindMinZ = Math.min(bindMinZ, bz);
              bindMaxX = Math.max(bindMaxX, bx);
              bindMaxY = Math.max(bindMaxY, by);
              bindMaxZ = Math.max(bindMaxZ, bz);
            }
          }
        }
      }

      bones.push({
        jointIndex: jIdx,
        gltfNodeIndex: nIdx,
        name: trimmedName,
        displayName: isEmpty ? `(Unnamed Joint #${jIdx})` : trimmedName,
        parentJointIndex,
        parentName: null,
        childJointIndices: [],
        depth: 0,
        isRoot: parentJointIndex === null,
        isDuplicateName: !isEmpty && (nameOccurrences.get(trimmedName) ?? 0) > 1,
        isEmptyName: isEmpty,
        isUnusualName: Boolean(unusualReason),
        unusualReason,
        restTranslation,
        restRotation,
        restScale,
        hasUnitQuaternion,
        hasValidPositiveScale,
        inverseBindDeterminant: ibmDet,
        inverseBindInvertible: ibmInvertible,
        bindWorldPosition: bindWorldPos,
      });
    }

    const boneByJointIdx = new Map<number, BoneNodeReport>();
    for (const b of bones) boneByJointIdx.set(b.jointIndex, b);

    for (const b of bones) {
      if (b.parentJointIndex !== null) {
        const parentBone = boneByJointIdx.get(b.parentJointIndex);
        if (parentBone) {
          b.parentName = parentBone.displayName;
          parentBone.childJointIndices.push(b.jointIndex);
        }
      }
    }

    let maxDepth = 0;
    const computeDepth = (b: BoneNodeReport, stack: Set<number>): number => {
      if (b.parentJointIndex === null) return 0;
      if (stack.has(b.jointIndex)) {
        hasCycleOrBroken = true;
        return 0;
      }
      stack.add(b.jointIndex);
      const parent = boneByJointIdx.get(b.parentJointIndex);
      const d = parent ? computeDepth(parent, stack) + 1 : 0;
      stack.delete(b.jointIndex);
      return d;
    };

    for (const b of bones) {
      b.depth = computeDepth(b, new Set());
      if (b.depth > maxDepth) maxDepth = b.depth;
    }

    const buildTreeNode = (
      b: BoneNodeReport,
      visited: Set<number>,
    ): BoneHierarchyTreeNode => {
      visited.add(b.jointIndex);
      const children = b.childJointIndices
        .map((cid) => boneByJointIdx.get(cid))
        .filter((child): child is BoneNodeReport =>
          Boolean(child && !visited.has(child.jointIndex)),
        )
        .map((child) => buildTreeNode(child, visited));
      return {
        jointIndex: b.jointIndex,
        gltfNodeIndex: b.gltfNodeIndex,
        name: b.displayName,
        depth: b.depth,
        isRoot: b.isRoot,
        isDuplicate: b.isDuplicateName,
        isUnusual: b.isUnusualName,
        children,
      };
    };

    const rootBones = bones.filter((b) => b.isRoot);
    const hierarchyTree = rootBones.map((rb) => buildTreeNode(rb, new Set()));

    let armatureName: string | null = null;
    let armatureScale: [number, number, number] | null = null;
    if (rootBones.length > 0) {
      const parentNodeIdx = nodeParentMap.get(rootBones[0].gltfNodeIndex);
      if (parentNodeIdx !== undefined && rawNodes[parentNodeIdx]) {
        const pNode = rawNodes[parentNodeIdx];
        armatureName = pNode.name ?? `Node #${parentNodeIdx}`;
        if (pNode.scale) {
          armatureScale = [...pNode.scale];
        } else if (Array.isArray(pNode.matrix) && pNode.matrix.length === 16) {
          const sVec = new THREE.Vector3();
          new THREE.Matrix4().fromArray(pNode.matrix).decompose(
            new THREE.Vector3(),
            new THREE.Quaternion(),
            sVec,
          );
          armatureScale = [sVec.x, sVec.y, sVec.z];
        }
      }
    }

    const explicitRootName =
      skinDef.skeleton !== undefined && rawNodes[skinDef.skeleton]
        ? rawNodes[skinDef.skeleton].name || `Node #${skinDef.skeleton}`
        : null;

    const matchingThreeSkeleton =
      threeSkeletonArray.find((sk) => sk.bones.length === bones.length) ?? null;

    if (matchingThreeSkeleton) {
      matchingThreeSkeleton.bones.forEach((threeBone, jIdx) => {
        skeletonBonesByJointKey.set(`skin-${sIdx}:${jIdx}`, threeBone);
      });
    } else {
      bones.forEach((b) => {
        const candidate = allThreeBones.find((tb) => tb.name === b.name);
        if (candidate) {
          skeletonBonesByJointKey.set(`skin-${sIdx}:${b.jointIndex}`, candidate);
        }
      });
    }

    if (emptyBoneCount > 0) {
      issues.push({
        severity: 'warning',
        code: 'EMPTY_BONE_NAMES',
        title: 'Unnamed Skeleton Joints',
        message: `Skin #${sIdx} contains ${emptyBoneCount} unnamed bone(s). Unnamed joints prevent deterministic bone path matching.`,
        category: 'hierarchy',
        basis: 'confirmed_fact',
      });
    }

    if (rootBones.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'MULTIPLE_ROOT_BONES',
        title: 'Multiple Disjoint Root Joints in Skin',
        message: `Skin #${sIdx} has ${rootBones.length} disjoint root bones (${rootBones.map((r) => `"${r.displayName}"`).join(', ')}). Standard character rigs usually share a single root pelvis/hips chain.`,
        category: 'hierarchy',
        basis: 'confirmed_fact',
      });
    }

    if (unusualBoneNames.length > 0) {
      issues.push({
        severity: 'info',
        code: 'UNUSUAL_OR_LEAF_BONE_NAMES',
        title: 'Helper or Leaf Tip Joints Present in Skin',
        message: `Skin #${sIdx} includes ${unusualBoneNames.length} helper/leaf joint(s) (e.g., "${unusualBoneNames[0].name}" — ${unusualBoneNames[0].reason}).`,
        category: 'hierarchy',
        basis: 'heuristic',
      });
    }

    const connectedMeshes = skinnedMeshNamesBySkinIndex.get(sIdx) ?? [];
    const skelName =
      skinDef.name ||
      explicitRootName ||
      armatureName ||
      (rootBones[0]?.displayName ? `${rootBones[0].displayName} Rig` : `Skin #${sIdx}`);

    skeletonReports.push({
      id: `skin-${sIdx}`,
      name: skelName,
      gltfSkinIndex: sIdx,
      threeSkeletonDetected: Boolean(matchingThreeSkeleton),
      totalBoneCount: bones.length,
      boneNames: bones.map((b) => b.displayName),
      rootBoneNames: rootBones.map((r) => r.displayName),
      explicitSkeletonRootNodeName: explicitRootName,
      armatureContainerNodeName: armatureName,
      armatureContainerScale: armatureScale,
      maxDepth,
      duplicateBoneNames,
      emptyBoneCount,
      unusualBoneNames,
      hasMultipleRoots: rootBones.length > 1,
      hasCycleOrBrokenParent: hasCycleOrBroken,
      connectedSkinnedMeshNames: connectedMeshes,
      bones,
      hierarchyTree,
    });
  }

  // 5. Skinning Validation
  const primitiveReports: MeshPrimitiveSkinningReport[] = [];
  let totalSkinnedVertices = 0;
  let totalNegativeWeightVerts = 0;
  let totalNonFiniteWeightVerts = 0;
  let totalZeroInfluenceVerts = 0;
  let totalUnnormalizedVerts = 0;
  let totalOutOfRangeVerts = 0;
  let disconnectedSkinAttrMeshes = 0;
  let meshSkeletonConsistent = true;

  const rawMeshes = gltfJson.meshes ?? [];
  const referencedMeshIndices = new Set<number>();
  const meshInstances: Array<{ nodeIndex: number | null; meshIndex: number }> = [];

  for (let nIdx = 0; nIdx < rawNodes.length; nIdx++) {
    const mIdx = rawNodes[nIdx]?.mesh;
    if (typeof mIdx === 'number') {
      referencedMeshIndices.add(mIdx);
      meshInstances.push({ nodeIndex: nIdx, meshIndex: mIdx });
    }
  }
  for (let mIdx = 0; mIdx < rawMeshes.length; mIdx++) {
    if (!referencedMeshIndices.has(mIdx)) {
      meshInstances.push({ nodeIndex: null, meshIndex: mIdx });
    }
  }

  for (const inst of meshInstances) {
    const nodeDef = inst.nodeIndex !== null ? rawNodes[inst.nodeIndex] : undefined;
    const meshDef = rawMeshes[inst.meshIndex];
    if (!meshDef) {
      meshSkeletonConsistent = false;
      issues.push({
        severity: 'error',
        code: 'INVALID_NODE_MESH_INDEX',
        title: 'Node References Missing Mesh',
        message: `Node #${inst.nodeIndex} references nonexistent mesh #${inst.meshIndex}.`,
        category: 'skinning',
        basis: 'confirmed_fact',
      });
      continue;
    }

    const nodeName =
      nodeDef?.name ||
      (inst.nodeIndex !== null ? `Node #${inst.nodeIndex}` : '(Unreferenced Mesh)');
    const meshName = meshDef.name || `Mesh #${inst.meshIndex}`;
    const hasSkinOnNode = typeof nodeDef?.skin === 'number';
    const boundSkinIdx = hasSkinOnNode ? (nodeDef!.skin as number) : null;
    const skinDef =
      boundSkinIdx !== null && boundSkinIdx >= 0 && boundSkinIdx < rawSkins.length
        ? rawSkins[boundSkinIdx]
        : null;

    if (hasSkinOnNode && !skinDef) {
      meshSkeletonConsistent = false;
      issues.push({
        severity: 'error',
        code: 'INVALID_NODE_SKIN_INDEX',
        title: 'Node References Nonexistent Skin',
        message: `Node "${nodeName}" references out-of-range skin #${boundSkinIdx} (total skins: ${rawSkins.length}).`,
        category: 'skinning',
        basis: 'confirmed_fact',
      });
    }

    const skeletonJointCount = skinDef?.joints?.length ?? 0;
    const primitives = meshDef.primitives ?? [];

    for (let pIdx = 0; pIdx < primitives.length; pIdx++) {
      const prim = primitives[pIdx];
      const attrs = prim.attributes ?? {};

      const jointsKeys = Object.keys(attrs)
        .filter((k) => /^JOINTS_\d+$/.test(k))
        .sort();
      const weightsKeys = Object.keys(attrs)
        .filter((k) => /^WEIGHTS_\d+$/.test(k))
        .sort();

      const hasJoints = jointsKeys.length > 0;
      const hasWeights = weightsKeys.length > 0;

      let vertexCount = 0;
      const posAccIdx = attrs.POSITION;
      if (typeof posAccIdx === 'number' && gltfJson.accessors?.[posAccIdx]) {
        vertexCount = gltfJson.accessors[posAccIdx].count;
      } else if (hasJoints && gltfJson.accessors?.[attrs[jointsKeys[0]]]) {
        vertexCount = gltfJson.accessors[attrs[jointsKeys[0]]].count;
      }

      const notes: string[] = [];

      if ((hasJoints || hasWeights) && !hasSkinOnNode) {
        disconnectedSkinAttrMeshes++;
        meshSkeletonConsistent = false;
        const msg = `Mesh "${meshName}" (node "${nodeName}") contains vertex skinning attributes (${[...jointsKeys, ...weightsKeys].join(', ')}) but its scene node has no "skin" reference, so it is NOT connected to any skeleton.`;
        notes.push(msg);
        issues.push({
          severity: 'warning',
          code: 'SKIN_ATTRIBUTES_WITHOUT_NODE_SKIN',
          title: 'Mesh Has Skin Attributes But Is Disconnected From Skeleton',
          message: msg,
          category: 'skinning',
          basis: 'confirmed_fact',
        });
      }

      if (hasSkinOnNode && (!hasJoints || !hasWeights)) {
        meshSkeletonConsistent = false;
        const msg = `Node "${nodeName}" binds to skin #${boundSkinIdx}, but mesh "${meshName}" primitive #${pIdx} is missing ${!hasJoints && !hasWeights ? 'both JOINTS_0 and WEIGHTS_0' : !hasJoints ? 'JOINTS_0' : 'WEIGHTS_0'}.`;
        notes.push(msg);
        issues.push({
          severity: 'error',
          code: 'MISSING_SKINNING_ATTRIBUTES',
          title: 'Skinned Mesh Missing JOINTS or WEIGHTS Attributes',
          message: msg,
          category: 'skinning',
          basis: 'confirmed_fact',
        });
      }

      if (hasJoints !== hasWeights || jointsKeys.length !== weightsKeys.length) {
        meshSkeletonConsistent = false;
        const msg = `Mesh "${meshName}" primitive #${pIdx} has mismatched skinning attribute sets (${jointsKeys.length} JOINTS set(s) vs ${weightsKeys.length} WEIGHTS set(s)).`;
        notes.push(msg);
        issues.push({
          severity: 'error',
          code: 'MISMATCHED_JOINTS_WEIGHTS_SETS',
          title: 'Mismatched JOINTS and WEIGHTS Attribute Sets',
          message: msg,
          category: 'skinning',
          basis: 'confirmed_fact',
        });
      }

      const matchingThreeSkinned = threeSkinnedMeshes.some(
        (sm) =>
          sm.skeleton instanceof THREE.Skeleton &&
          sm.skeleton.bones.length > 0 &&
          (sm.name === meshName ||
            sm.name === nodeName ||
            sm.parent?.name === nodeName ||
            threeSkinnedMeshes.length > 0),
      );

      if (!hasJoints && !hasWeights && !hasSkinOnNode) {
        primitiveReports.push({
          nodeName,
          meshName,
          gltfMeshIndex: inst.meshIndex,
          primitiveIndex: pIdx,
          vertexCount,
          hasSkinReferenceOnNode: false,
          boundSkinIndex: null,
          threeIsSkinnedMesh: false,
          threeConnectedToSkeleton: false,
          hasJointsAttribute: false,
          hasWeightsAttribute: false,
          jointsSetCount: 0,
          weightsSetCount: 0,
          jointsComponentTypes: [],
          weightsComponentTypes: [],
          skeletonJointCount: 0,
          validVertexCount: 0,
          negativeWeightVertexCount: 0,
          nonFiniteWeightVertexCount: 0,
          zeroInfluenceVertexCount: 0,
          unnormalizedVertexCount: 0,
          outOfRangeIndexVertexCount: 0,
          maxObservedJointIndex: null,
          minWeightSum: null,
          maxWeightSum: null,
          status: 'not_skinned',
          notes,
        });
        continue;
      }

      let primInvalid = !hasJoints || !hasWeights || !hasSkinOnNode || !skinDef;
      const jointsSets: Float64Array[] = [];
      const weightsSets: Float64Array[] = [];
      const jointsComponentTypes: string[] = [];
      const weightsComponentTypes: string[] = [];

      const pairCount = Math.min(jointsKeys.length, weightsKeys.length);
      for (let setIdx = 0; setIdx < pairCount; setIdx++) {
        try {
          const jAcc = readGltfAccessor(gltfJson, attrs[jointsKeys[setIdx]], loadedBuffers);
          const wAcc = readGltfAccessor(gltfJson, attrs[weightsKeys[setIdx]], loadedBuffers);

          jointsComponentTypes.push(
            COMPONENT_TYPE_NAMES[jAcc.componentType] ?? String(jAcc.componentType),
          );
          weightsComponentTypes.push(
            COMPONENT_TYPE_NAMES[wAcc.componentType] ?? String(wAcc.componentType),
          );

          if (
            jAcc.type !== 'VEC4' ||
            (jAcc.componentType !== 5121 && jAcc.componentType !== 5123)
          ) {
            primInvalid = true;
            const msg = `${jointsKeys[setIdx]} on "${meshName}" uses ${jAcc.type} / ${COMPONENT_TYPE_NAMES[jAcc.componentType] ?? jAcc.componentType}; glTF 2.0 requires VEC4 UNSIGNED_BYTE or UNSIGNED_SHORT.`;
            notes.push(msg);
            issues.push({
              severity: 'error',
              code: 'INVALID_JOINTS_ACCESSOR_FORMAT',
              title: 'Invalid JOINTS Accessor Component Type',
              message: msg,
              category: 'skinning',
              basis: 'confirmed_fact',
            });
          }

          if (wAcc.type !== 'VEC4') {
            primInvalid = true;
            const msg = `${weightsKeys[setIdx]} on "${meshName}" uses ${wAcc.type}; expected VEC4.`;
            notes.push(msg);
            issues.push({
              severity: 'error',
              code: 'INVALID_WEIGHTS_ACCESSOR_FORMAT',
              title: 'Invalid WEIGHTS Accessor Format',
              message: msg,
              category: 'skinning',
              basis: 'confirmed_fact',
            });
          }

          if (jAcc.count !== wAcc.count || (vertexCount > 0 && jAcc.count !== vertexCount)) {
            primInvalid = true;
            const msg = `Vertex count mismatch on "${meshName}": POSITION=${vertexCount}, ${jointsKeys[setIdx]}=${jAcc.count}, ${weightsKeys[setIdx]}=${wAcc.count}.`;
            notes.push(msg);
            issues.push({
              severity: 'error',
              code: 'SKINNING_VERTEX_COUNT_MISMATCH',
              title: 'Skinning Attribute Count Mismatch',
              message: msg,
              category: 'skinning',
              basis: 'confirmed_fact',
            });
          }

          vertexCount = Math.min(
            vertexCount > 0 ? vertexCount : jAcc.count,
            jAcc.count,
            wAcc.count,
          );
          jointsSets.push(jAcc.values);
          weightsSets.push(wAcc.values);
        } catch (err) {
          primInvalid = true;
          const msg = `Failed reading skinning accessors on "${meshName}": ${err instanceof Error ? err.message : String(err)}`;
          notes.push(msg);
          issues.push({
            severity: 'error',
            code: 'SKINNING_ACCESSOR_READ_ERROR',
            title: 'Skinning Accessor Read Failure',
            message: msg,
            category: 'skinning',
            basis: 'confirmed_fact',
          });
        }
      }

      let validVerts = 0;
      let negWeightVerts = 0;
      let nonFiniteVerts = 0;
      let zeroInfluenceVerts = 0;
      let unnormalizedVerts = 0;
      let outOfRangeVerts = 0;
      let maxObservedJointIndex: number | null = null;
      let minWeightSum: number | null = null;
      let maxWeightSum: number | null = null;

      if (jointsSets.length > 0 && weightsSets.length > 0 && vertexCount > 0) {
        totalSkinnedVertices += vertexCount;

        for (let v = 0; v < vertexCount; v++) {
          let vHasNegative = false;
          let vHasNonFinite = false;
          let vHasOutOfRange = false;
          let weightSum = 0;

          for (let s = 0; s < jointsSets.length; s++) {
            const jArr = jointsSets[s];
            const wArr = weightsSets[s];
            const base = v * 4;

            for (let k = 0; k < 4; k++) {
              const jVal = jArr[base + k];
              const wVal = wArr[base + k];

              if (!Number.isFinite(wVal) || !Number.isFinite(jVal)) {
                vHasNonFinite = true;
                continue;
              }

              if (maxObservedJointIndex === null || jVal > maxObservedJointIndex) {
                maxObservedJointIndex = jVal;
              }

              if (wVal < -1e-7) {
                vHasNegative = true;
              }

              if (
                !Number.isInteger(jVal) ||
                jVal < 0 ||
                (skeletonJointCount > 0 && jVal >= skeletonJointCount)
              ) {
                vHasOutOfRange = true;
              }

              weightSum += wVal;
            }
          }

          if (!vHasNonFinite) {
            if (minWeightSum === null || weightSum < minWeightSum) minWeightSum = weightSum;
            if (maxWeightSum === null || weightSum > maxWeightSum) maxWeightSum = weightSum;
          }

          const vZeroInfluence = !vHasNonFinite && weightSum <= 1e-6;
          const vUnnormalized =
            !vHasNonFinite && !vZeroInfluence && Math.abs(weightSum - 1.0) > 1e-3;

          if (vHasNonFinite) nonFiniteVerts++;
          if (vHasNegative) negWeightVerts++;
          if (vHasOutOfRange) outOfRangeVerts++;
          if (vZeroInfluence) zeroInfluenceVerts++;
          if (vUnnormalized) unnormalizedVerts++;

          if (
            !vHasNonFinite &&
            !vHasNegative &&
            !vHasOutOfRange &&
            !vZeroInfluence &&
            !vUnnormalized
          ) {
            validVerts++;
          }
        }
      }

      totalNegativeWeightVerts += negWeightVerts;
      totalNonFiniteWeightVerts += nonFiniteVerts;
      totalZeroInfluenceVerts += zeroInfluenceVerts;
      totalUnnormalizedVerts += unnormalizedVerts;
      totalOutOfRangeVerts += outOfRangeVerts;

      if (
        negWeightVerts > 0 ||
        nonFiniteVerts > 0 ||
        zeroInfluenceVerts > 0 ||
        unnormalizedVerts > 0 ||
        outOfRangeVerts > 0
      ) {
        primInvalid = true;
      }

      if (outOfRangeVerts > 0) {
        issues.push({
          severity: 'error',
          code: 'INVALID_SKIN_INDICES',
          title: 'Skin Joint Indices Out of Skeleton Range',
          message: `Mesh "${meshName}" has ${outOfRangeVerts.toLocaleString()} vertex/vertices referencing joint indices outside valid range [0..${Math.max(0, skeletonJointCount - 1)}] (max observed index: ${maxObservedJointIndex}).`,
          category: 'skinning',
          basis: 'confirmed_fact',
        });
      }

      if (negWeightVerts > 0 || nonFiniteVerts > 0) {
        issues.push({
          severity: 'error',
          code: 'NEGATIVE_OR_NAN_SKIN_WEIGHTS',
          title: 'Negative or Non-Finite Vertex Weights',
          message: `Mesh "${meshName}" contains ${negWeightVerts} vertex/vertices with negative weights and ${nonFiniteVerts} with NaN/Infinity weights.`,
          category: 'skinning',
          basis: 'confirmed_fact',
        });
      }

      if (zeroInfluenceVerts > 0) {
        issues.push({
          severity: 'error',
          code: 'UNWEIGHTED_VERTICES',
          title: 'Vertices With Zero Bone Influence',
          message: `Mesh "${meshName}" has ${zeroInfluenceVerts.toLocaleString()} of ${vertexCount.toLocaleString()} vertex/vertices with total bone weight = 0 (no valid bone influence).`,
          category: 'skinning',
          basis: 'confirmed_fact',
        });
      }

      if (unnormalizedVerts > 0) {
        issues.push({
          severity: 'warning',
          code: 'UNNORMALIZED_SKIN_WEIGHTS',
          title: 'Unnormalized Vertex Bone Weights',
          message: `Mesh "${meshName}" has ${unnormalizedVerts.toLocaleString()} of ${vertexCount.toLocaleString()} vertex/vertices whose weights do not sum to 1.0 (sum range: ${minWeightSum?.toFixed(4)} .. ${maxWeightSum?.toFixed(4)}). Normalization is required (original uploaded file left unmodified).`,
          category: 'skinning',
          basis: 'confirmed_fact',
        });
      }

      primitiveReports.push({
        nodeName,
        meshName,
        gltfMeshIndex: inst.meshIndex,
        primitiveIndex: pIdx,
        vertexCount,
        hasSkinReferenceOnNode: hasSkinOnNode,
        boundSkinIndex: boundSkinIdx,
        threeIsSkinnedMesh: hasSkinOnNode && matchingThreeSkinned,
        threeConnectedToSkeleton: hasSkinOnNode && matchingThreeSkinned && Boolean(skinDef),
        hasJointsAttribute: hasJoints,
        hasWeightsAttribute: hasWeights,
        jointsSetCount: jointsKeys.length,
        weightsSetCount: weightsKeys.length,
        jointsComponentTypes,
        weightsComponentTypes,
        skeletonJointCount,
        validVertexCount: validVerts,
        negativeWeightVertexCount: negWeightVerts,
        nonFiniteWeightVertexCount: nonFiniteVerts,
        zeroInfluenceVertexCount: zeroInfluenceVerts,
        unnormalizedVertexCount: unnormalizedVerts,
        outOfRangeIndexVertexCount: outOfRangeVerts,
        maxObservedJointIndex,
        minWeightSum,
        maxWeightSum,
        status: primInvalid ? 'invalid' : 'valid',
        notes,
      });
    }
  }

  // 6. Compute Statuses, Bind Pose Summary & Humanoid Summary
  const skeletonStatus: SkeletonStatus =
    skeletonReports.length > 0 || uniqueThreeSkeletons.size > 0 ? 'Present' : 'Missing';

  const connectedSkinnedPrimitives = primitiveReports.filter(
    (p) => p.hasSkinReferenceOnNode && p.threeConnectedToSkeleton,
  );
  const skinnedMeshStatus: SkinnedMeshStatus =
    threeSkinnedMeshes.length > 0 && connectedSkinnedPrimitives.length > 0
      ? 'Present'
      : 'Missing';

  let boneWeightsStatus: BoneWeightsStatus;
  const skinnedOrCandidatePrimitives = primitiveReports.filter(
    (p) => p.hasSkinReferenceOnNode || p.hasJointsAttribute || p.hasWeightsAttribute,
  );

  if (skinnedOrCandidatePrimitives.length === 0) {
    boneWeightsStatus = 'Missing';
  } else if (
    skinnedOrCandidatePrimitives.some(
      (p) => !p.hasWeightsAttribute || !p.hasJointsAttribute,
    ) &&
    totalSkinnedVertices === 0
  ) {
    boneWeightsStatus = 'Missing';
  } else if (
    !meshSkeletonConsistent ||
    skinnedOrCandidatePrimitives.some((p) => p.status === 'invalid')
  ) {
    boneWeightsStatus = 'Invalid';
  } else {
    boneWeightsStatus = 'Valid';
  }

  const skinningSummary: SkinningValidationSummary = {
    status: boneWeightsStatus,
    totalMeshInstances: threeSkinnedMeshes.length + threeStaticMeshes.length,
    skinnedMeshCount: threeSkinnedMeshes.length,
    nonSkinnedMeshCount: threeStaticMeshes.length,
    disconnectedSkinAttributeMeshCount: disconnectedSkinAttrMeshes,
    meshAndSkeletonConsistent:
      meshSkeletonConsistent &&
      (skeletonStatus === 'Missing' || threeSkinnedMeshes.length > 0),
    totalSkinnedVerticesInspected: totalSkinnedVertices,
    negativeWeightVertices: totalNegativeWeightVerts,
    nonFiniteWeightVertices: totalNonFiniteWeightVerts,
    zeroInfluenceVertices: totalZeroInfluenceVerts,
    unnormalizedVertices: totalUnnormalizedVerts,
    outOfRangeJointVertices: totalOutOfRangeVerts,
    requiresWeightNormalization: totalUnnormalizedVerts > 0,
    primitives: primitiveReports,
  };

  const boneHierarchyStatus: BoneHierarchyStatus =
    skeletonStatus === 'Present' &&
    skeletonReports.length > 0 &&
    skeletonReports.every(
      (sk) =>
        sk.totalBoneCount > 0 &&
        sk.duplicateBoneNames.length === 0 &&
        sk.emptyBoneCount === 0 &&
        !sk.hasMultipleRoots &&
        !sk.hasCycleOrBrokenParent,
    )
      ? 'Valid'
      : 'Issues Found';

  let bindPoseStatus: BindPoseStatus;
  if (skeletonStatus === 'Missing') {
    bindPoseStatus = 'Missing';
  } else if (
    !allIbmCountsMatch ||
    nonFiniteMatrixCount > 0 ||
    singularMatrixCount > 0 ||
    invalidRestTransformCount > 0
  ) {
    bindPoseStatus = 'Invalid';
    if (singularMatrixCount > 0 || nonFiniteMatrixCount > 0) {
      issues.push({
        severity: 'error',
        code: 'INVALID_BIND_MATRICES',
        title: 'Singular or Non-Finite Inverse Bind Matrices',
        message: `Detected ${singularMatrixCount} singular (non-invertible) and ${nonFiniteMatrixCount} non-finite inverse bind matrices.`,
        category: 'bind_pose',
        basis: 'confirmed_fact',
      });
    }
    if (invalidRestTransformCount > 0) {
      issues.push({
        severity: 'warning',
        code: 'INVALID_REST_TRANSFORMS',
        title: 'Invalid Joint Rest Transforms',
        message: `${invalidRestTransformCount} bone(s) have non-unit rest rotation quaternions or zero/negative rest scale.`,
        category: 'bind_pose',
        basis: 'confirmed_fact',
      });
    }
  } else if (!anyExplicitIbm) {
    bindPoseStatus = 'Missing';
  } else {
    bindPoseStatus = 'Available';
  }

  const allBoneNames = skeletonReports.flatMap((s) => s.boneNames);
  const rigConvention = detectRigNamingScheme(allBoneNames);
  const hasBindBounds = Number.isFinite(bindMinY) && Number.isFinite(bindMaxY);
  const estimatedHeight = hasBindBounds
    ? Number(Math.max(bindMaxY - bindMinY, bindMaxZ - bindMinZ).toFixed(4))
    : null;

  const bindPoseSummary: BindPoseValidationSummary = {
    status: bindPoseStatus,
    hasExplicitInverseBindMatrices: anyExplicitIbm,
    ibmAccessorCountMatchesJoints: allIbmCountsMatch,
    totalMatricesChecked: totalIbmMatricesChecked,
    nonFiniteMatrixCount,
    singularNonInvertibleMatrixCount: singularMatrixCount,
    negativeDeterminantMatrixCount: negativeDetMatrixCount,
    invalidRestTransformBoneCount: invalidRestTransformCount,
    bindBoundsMin: hasBindBounds
      ? [
          Number(bindMinX.toFixed(4)),
          Number(bindMinY.toFixed(4)),
          Number(bindMinZ.toFixed(4)),
        ]
      : null,
    bindBoundsMax: hasBindBounds
      ? [
          Number(bindMaxX.toFixed(4)),
          Number(bindMaxY.toFixed(4)),
          Number(bindMaxZ.toFixed(4)),
        ]
      : null,
    estimatedRigHeight: estimatedHeight,
    detectedNamingConvention: rigConvention.scheme,
    mixamoNamingDetected: rigConvention.isMixamo,
    notes: bindNotes,
  };

  const humanoidSummary = analyzeHumanoidStructure(skeletonReports);

  let texturesStatus: TexturesStatus = 'Loaded';
  if (textureReports.some((t) => t.status === 'missing')) {
    texturesStatus = 'Missing';
  } else if (textureReports.some((t) => t.status === 'failed')) {
    texturesStatus = 'Failed';
  }

  // 7. Confirmed Facts vs Heuristic Findings & Final Classification
  if (skeletonStatus === 'Present') {
    const totalBones = skeletonReports.reduce((acc, s) => acc + s.totalBoneCount, 0);
    confirmedFacts.push(
      `Detected ${rawSkins.length} glTF skin(s) and ${uniqueThreeSkeletons.size} post-load THREE.Skeleton instance(s) totaling ${totalBones} joint(s).`,
    );
    for (const sk of skeletonReports) {
      confirmedFacts.push(
        `Skeleton "${sk.name}": ${sk.totalBoneCount} bones, root [${sk.rootBoneNames.join(', ') || 'none'}], max hierarchy depth ${sk.maxDepth}, connected SkinnedMeshes: ${sk.connectedSkinnedMeshNames.length}.`,
      );
    }
  } else {
    confirmedFacts.push(
      `No "skins" array entries or THREE.Skeleton instances exist in "${primaryGltfName}" (${threeStaticMeshes.length} static mesh(es) loaded).`,
    );
    issues.push({
      severity: 'error',
      code: 'NO_SKELETON_DETECTED',
      title: 'No Skeleton Present in GLTF',
      message: `"${primaryGltfName}" contains ${threeStaticMeshes.length} static mesh(es) and 0 skeletons. Character cannot be animated as a skeletal rig.`,
      category: 'skeleton',
      basis: 'confirmed_fact',
    });
  }

  if (skinnedMeshStatus === 'Present') {
    confirmedFacts.push(
      `Verified ${threeSkinnedMeshes.length} THREE.SkinnedMesh object(s) inspecting ${totalSkinnedVertices.toLocaleString()} skinned vertices (${boneWeightsStatus === 'Valid' ? 'all joint indices within bounds and vertex weights normalized' : 'skinning weight or index issues detected'}).`,
    );
  } else if (skeletonStatus === 'Present') {
    confirmedFacts.push(
      `Skeleton is present, but 0 THREE.SkinnedMesh objects are bound to it (${threeStaticMeshes.length} unbound static mesh(es)).`,
    );
    issues.push({
      severity: 'warning',
      code: 'SKELETON_NOT_SKINNED_TO_MESH',
      title: 'Skeleton Present Without Skinned Mesh',
      message: `GLTF defines ${skeletonReports.length} skeleton(s), but no mesh is bound as a SkinnedMesh.`,
      category: 'skinning',
      basis: 'confirmed_fact',
    });
  }

  if (bindPoseStatus === 'Available') {
    confirmedFacts.push(
      `Verified ${totalIbmMatricesChecked} invertible 4x4 inverseBindMatrices${estimatedHeight !== null ? ` (bind-pose skeleton span: ${estimatedHeight} units)` : ''}.`,
    );
  }

  if (textureReports.length === 0) {
    confirmedFacts.push('GLTF references 0 external or embedded image textures.');
  } else {
    const loadedCount = textureReports.filter((t) => t.status === 'loaded').length;
    confirmedFacts.push(
      `Texture check: ${loadedCount} of ${textureReports.length} referenced image(s) loaded (${texturesStatus}).`,
    );
  }

  if (skeletonStatus === 'Present') {
    heuristicFindings.push(
      `Detected bone naming convention: ${humanoidSummary.detectedNamingPattern} (Mixamo-style pattern: ${humanoidSummary.mixamoStyleDetected ? 'Yes' : 'No'}).`,
    );
    heuristicFindings.push(
      `Humanoid bone heuristic scan: ${humanoidSummary.foundCount} Found, ${humanoidSummary.possibleMatchCount} Possible match, ${humanoidSummary.ambiguousCount} Ambiguous, ${humanoidSummary.missingCount} Missing out of ${humanoidSummary.totalSlotsChecked} common humanoid slots -> "${humanoidSummary.status}".`,
    );
    const primaryRoots = skeletonReports[0]?.rootBoneNames ?? [];
    if (
      primaryRoots.length === 1 &&
      /^root$/i.test(primaryRoots[0]) &&
      skeletonReports[0]?.bones.some((b) => /^pelvis|hips?$/i.test(b.name))
    ) {
      heuristicFindings.push(
        'Root bone is a dedicated ground-origin "root" joint above "pelvis" (typical Unreal Mannequin root-motion hierarchy; note Mixamo FBX animations often omit an extra ground root above Hips).',
      );
    }
    if (humanoidSummary.status === 'Incomplete') {
      const missingCore = humanoidSummary.slots
        .filter(
          (s) =>
            s.isCoreBipedalSlot && (s.status === 'Missing' || s.status === 'Ambiguous'),
        )
        .map((s) => `${s.label} (${s.status})`);
      issues.push({
        severity: 'warning',
        code: 'INCOMPLETE_HUMANOID_STRUCTURE',
        title: 'Incomplete Humanoid Bone Coverage (Heuristic)',
        message:
          missingCore.length > 0
            ? `Core humanoid limb/torso slots missing or ambiguous: ${missingCore.join(', ')}.`
            : 'Skeleton partially matches humanoid structure, but bilateral hierarchy could not be confirmed.',
        category: 'humanoid',
        basis: 'heuristic',
      });
    }
  } else {
    heuristicFindings.push('Humanoid bone heuristic scan skipped because no skeleton is present.');
  }

  let finalClassification: FinalClassification;
  if (skeletonStatus === 'Missing') {
    finalClassification = 'SKELETON_MISSING';
  } else if (skinnedMeshStatus === 'Missing') {
    finalClassification = 'SKELETON_PRESENT_BUT_NOT_SKINNED';
  } else if (boneWeightsStatus !== 'Valid' || bindPoseStatus === 'Invalid') {
    finalClassification = 'SKELETON_PRESENT_WITH_WEIGHT_ISSUES';
  } else {
    finalClassification = 'RIGGED_AND_SKINNED';
  }

  const report: CharacterInspectionReport = {
    schemaVersion: '1.0.0',
    phase: 'Phase 1 — Browser Structural Inspection Only',
    slot,
    slotLabel,
    inspectedAtIso: new Date().toISOString(),
    primaryGltfFileName: primaryGltfName,
    gltfAssetMetadata: assetMeta,
    finalClassification,
    statuses: {
      skeleton: skeletonStatus,
      skinnedMesh: skinnedMeshStatus,
      boneWeights: boneWeightsStatus,
      boneHierarchy: boneHierarchyStatus,
      bindPose: bindPoseStatus,
      humanoidStructure: humanoidSummary.status,
      textures: texturesStatus,
    },
    uploadedFiles,
    licence,
    buffers: bufferReports,
    textures: textureReports,
    sceneSummary: {
      gltfSkinCount: rawSkins.length,
      threeSkeletonCount: uniqueThreeSkeletons.size,
      threeSkinnedMeshCount: threeSkinnedMeshes.length,
      threeStaticMeshCount: threeStaticMeshes.length,
      totalSceneNodes,
      allMeshesConnectedToSkeleton:
        threeSkinnedMeshes.length > 0 &&
        threeStaticMeshes.length === 0 &&
        disconnectedSkinAttrMeshes === 0,
    },
    skeletons: skeletonReports,
    skinning: skinningSummary,
    bindPose: bindPoseSummary,
    humanoid: humanoidSummary,
    confirmedFacts,
    heuristicFindings,
    issues,
    limitationsNotice: LIMITATIONS_NOTICE,
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    revokeLoaderUrls();
    disposeThreeScene(sceneRoot);
    skeletonBonesByJointKey.clear();
  };

  return {
    slot,
    sourceLabel,
    report,
    sceneRoot,
    skeletonBonesByJointKey,
    files,
    dispose,
  };
}
