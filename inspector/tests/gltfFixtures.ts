/**
 * Synthetic .gltf + .bin fixture builder for Phase 1 engine tests.
 * Builds a tiny valid glTF 2.0 document (4 vertices, 2 triangles) with
 * optional skins / joints / weights / textures, entirely in memory.
 * No files are read from disk and no uploaded asset is mutated.
 */

export interface FixtureOptions {
  /** Bone names in joint order. Empty = no skeleton. */
  boneNames?: string[];
  /** Parent joint index per bone (null = root). Defaults to a chain. */
  parents?: Array<number | null>;
  /** Bind a skin to the mesh node (default true when bones exist). */
  skinned?: boolean;
  /** Per-vertex joint indices (flat, 4 per vertex). */
  jointsOverride?: number[];
  /** Per-vertex weights (flat, 4 per vertex). */
  weightsOverride?: number[];
  /** Reference an external texture image. */
  textureUri?: string;
  /** Buffer URI declared in the .gltf (default "test.bin"). */
  bufferUri?: string;
  /** Omit the .bin File from the returned bundle (missing-BIN scenario). */
  omitBin?: boolean;
  /** Omit the texture File from the returned bundle (missing-texture scenario). */
  omitTexture?: boolean;
  /** Raw .gltf text override (e.g. invalid JSON). */
  rawGltfText?: string;
  /** Extra companion files (licence.txt etc). */
  extraFiles?: File[];
  gltfName?: string;
  binName?: string;
}

export const FULL_HUMANOID_BONES = [
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot',
];

export const FULL_HUMANOID_PARENTS: Array<number | null> = [
  null, 0, 1, 2, 3, 2, 5, 6, 7, 2, 9, 10, 11, 0, 13, 14, 0, 16, 17,
];

const POSITIONS = [
  0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
];
const NORMALS = [
  0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
];
const INDICES = [0, 1, 2, 0, 2, 3];

function identityMatrices(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  }
  return out;
}

class BinBuilder {
  bytes: number[] = [];
  bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [];
  accessors: Array<Record<string, unknown>> = [];

  private pushView(data: Uint8Array): number {
    while (this.bytes.length % 4 !== 0) this.bytes.push(0);
    const offset = this.bytes.length;
    this.bytes.push(...data);
    const idx = this.bufferViews.length;
    this.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    return idx;
  }

  addFloatAccessor(values: number[], type: string, min?: number[], max?: number[]): number {
    const buf = new ArrayBuffer(values.length * 4);
    const view = new DataView(buf);
    values.forEach((v, i) => view.setFloat32(i * 4, v, true));
    const bv = this.pushView(new Uint8Array(buf));
    const acc: Record<string, unknown> = {
      bufferView: bv, componentType: 5126, count: values.length / ({ SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type] ?? 1), type,
    };
    if (min) acc.min = min;
    if (max) acc.max = max;
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  addUint8Accessor(values: number[], type: string): number {
    const bv = this.pushView(new Uint8Array(values));
    this.accessors.push({ bufferView: bv, componentType: 5121, count: values.length / 4, type });
    return this.accessors.length - 1;
  }

  addUint16Accessor(values: number[], type: string): number {
    const buf = new ArrayBuffer(values.length * 2);
    const view = new DataView(buf);
    values.forEach((v, i) => view.setUint16(i * 2, v, true));
    const bv = this.pushView(new Uint8Array(buf));
    this.accessors.push({ bufferView: bv, componentType: 5123, count: values.length, type });
    return this.accessors.length - 1;
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

import { File as NodeFile } from 'node:buffer';

export function makeFile(name: string, content: string | Uint8Array, type = 'application/octet-stream'): File {
  // Use Node's File (with arrayBuffer()/text()) instead of jsdom's File stub.
  return new NodeFile([content as never], name, { type }) as unknown as File;
}

/** 1x1 transparent PNG bytes (valid PNG header for inspectImageBytes). */
export const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00,
  0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export function buildFixtureBundle(opts: FixtureOptions = {}): File[] {
  const gltfName = opts.gltfName ?? 'TestCharacter.gltf';
  const binName = opts.binName ?? 'test.bin';
  const bufferUri = opts.bufferUri ?? binName;
  const boneNames = opts.boneNames ?? FULL_HUMANOID_BONES;
  const hasSkeleton = boneNames.length > 0;
  const skinned = opts.skinned ?? hasSkeleton;

  if (opts.rawGltfText !== undefined) {
    const files: File[] = [makeFile(gltfName, opts.rawGltfText, 'model/gltf+json')];
    if (!opts.omitBin) files.push(makeFile(binName, new Uint8Array([0, 1, 2, 3])));
    if (opts.extraFiles) files.push(...opts.extraFiles);
    return files;
  }

  const parents = opts.parents ?? boneNames.map((_, i) => (i === 0 ? null : i - 1));
  const builder = new BinBuilder();

  const posAcc = builder.addFloatAccessor(POSITIONS, 'VEC3', [0, 0, 0], [1, 1, 1]);
  const normAcc = builder.addFloatAccessor(NORMALS, 'VEC3');
  const idxAcc = builder.addUint16Accessor(INDICES, 'SCALAR');

  let jointsAcc: number | null = null;
  let weightsAcc: number | null = null;
  let ibmAcc: number | null = null;

  if (hasSkeleton && skinned) {
    const joints = opts.jointsOverride ?? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const weights = opts.weightsOverride ?? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    jointsAcc = builder.addUint8Accessor(joints, 'VEC4');
    weightsAcc = builder.addFloatAccessor(weights, 'VEC4');
  }
  if (hasSkeleton) {
    ibmAcc = builder.addFloatAccessor(identityMatrices(boneNames.length), 'MAT4');
  }

  const binBytes = builder.toUint8Array();

  // Nodes: 0 = mesh node, 1..N = bone nodes
  const nodes: Array<Record<string, unknown>> = [];
  const meshNode: Record<string, unknown> = { name: 'TestMeshNode', mesh: 0 };
  if (hasSkeleton && skinned) meshNode.skin = 0;
  nodes.push(meshNode);

  const boneNodeIndex = boneNames.map((name, i) => {
    const node: Record<string, unknown> = {
      name,
      translation: [i * 0.1, i * 0.1, 0],
      children: [] as number[],
    };
    nodes.push(node);
    return nodes.length - 1;
  });
  boneNames.forEach((_, i) => {
    const p = parents[i];
    if (p !== null && p !== undefined && boneNodeIndex[p] !== undefined) {
      (nodes[boneNodeIndex[p]].children as number[]).push(boneNodeIndex[i]);
    }
  });

  const attributes: Record<string, number> = { POSITION: posAcc, NORMAL: normAcc };
  if (jointsAcc !== null) attributes.JOINTS_0 = jointsAcc;
  if (weightsAcc !== null) attributes.WEIGHTS_0 = weightsAcc;

  const material: Record<string, unknown> = { name: 'TestMaterial', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.2, 1] } };
  const gltf: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Phase1 Test Fixture Builder' },
    scene: 0,
    scenes: [{ nodes: hasSkeleton ? [0, boneNodeIndex[0]] : [0] }],
    nodes,
    meshes: [{ name: 'TestMesh', primitives: [{ attributes, indices: idxAcc, material: 0 }] }],
    materials: [material],
    buffers: [{ uri: bufferUri, byteLength: binBytes.length }],
    bufferViews: builder.bufferViews,
    accessors: builder.accessors,
  };

  if (hasSkeleton) {
    gltf.skins = [{
      name: 'TestSkin',
      joints: boneNodeIndex,
      skeleton: boneNodeIndex[0],
      inverseBindMatrices: ibmAcc,
    }];
  }

  if (opts.textureUri) {
    gltf.images = [{ uri: opts.textureUri, name: opts.textureUri }];
    gltf.textures = [{ source: 0 }];
    gltf.samplers = [{}];
    (material.pbrMetallicRoughness as Record<string, unknown>).baseColorTexture = { index: 0 };
  }

  const files: File[] = [
    makeFile(gltfName, JSON.stringify(gltf), 'model/gltf+json'),
  ];
  if (!opts.omitBin) files.push(makeFile(binName, binBytes));
  if (opts.textureUri && !opts.omitTexture) {
    const texName = opts.textureUri.split('/').pop() ?? 'texture.png';
    files.push(makeFile(texName, TINY_PNG, 'image/png'));
  }
  if (opts.extraFiles) files.push(...opts.extraFiles);
  return files;
}
