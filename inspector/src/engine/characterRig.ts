/**
 * Builds a character rig directly from glTF JSON.
 *
 * Why not always run GLTFLoader?
 * ------------------------------
 * Compatibility analysis only needs bone names, the parent/child hierarchy and
 * rest transforms. Parsing those straight from the glTF node graph is exact (it
 * is what GLTFLoader itself does for nodes), avoids decoding `.bin` accessors and
 * uploading textures, and therefore works identically in a Web Worker, in Node
 * (tests) and on a mid-range Android phone where a full textured load is the
 * expensive part.
 *
 * The 3D preview still loads the real character with GLTFLoader; both paths
 * produce the same bone hierarchy, which is asserted by the integration tests.
 */

import * as THREE from 'three';
import type { GltfJson } from './gltfBinaryUtils';
import { buildNormalizedSkeleton } from './fbxSkeleton';
import type { NormalizedSkeleton } from './animationTypes';

export interface CharacterRig {
  /** Root object holding the reconstructed node graph. */
  root: THREE.Object3D;
  skeleton: NormalizedSkeleton;
  /** Bone objects keyed by bone name (first occurrence wins). */
  bonesByName: Map<string, THREE.Bone>;
  /** Bone names referenced by any glTF skin (the deforming joints). */
  skinJointNames: string[];
  gltfVersion: string | null;
  generator: string | null;
}

function readVec3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  return Array.isArray(v) && v.length === 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : fallback;
}

function readQuat(v: unknown): [number, number, number, number] {
  return Array.isArray(v) && v.length === 4
    ? [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])]
    : [0, 0, 0, 1];
}

/**
 * Rebuilds the glTF node graph as Three.js objects, converting every node that a
 * skin references into a `THREE.Bone`.
 */
export function buildCharacterRigFromGltf(json: GltfJson): CharacterRig {
  const nodes = json.nodes ?? [];
  const jointIndices = new Set<number>();
  for (const skin of json.skins ?? []) {
    for (const j of skin.joints ?? []) jointIndices.add(j);
  }

  const objects: THREE.Object3D[] = nodes.map((node, idx) => {
    const obj: THREE.Object3D = jointIndices.has(idx) ? new THREE.Bone() : new THREE.Object3D();
    obj.name = node.name ?? `node_${idx}`;
    obj.position.set(...readVec3(node.translation, [0, 0, 0]));
    obj.quaternion.set(...readQuat(node.rotation));
    obj.scale.set(...readVec3(node.scale, [1, 1, 1]));
    if (Array.isArray(node.matrix) && node.matrix.length === 16) {
      const m = new THREE.Matrix4().fromArray(node.matrix);
      m.decompose(obj.position, obj.quaternion, obj.scale);
    }
    return obj;
  });

  // Attach children; remember which nodes are reachable so roots can be found.
  const hasParent = new Set<number>();
  nodes.forEach((node, idx) => {
    for (const childIdx of node.children ?? []) {
      if (childIdx < 0 || childIdx >= nodes.length) continue;
      objects[idx].add(objects[childIdx]);
      hasParent.add(childIdx);
    }
  });

  const root = new THREE.Group();
  root.name = '__gltf_node_root__';
  const sceneNodeIndices = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const topLevel =
    sceneNodeIndices.length > 0
      ? sceneNodeIndices
      : nodes.map((_, i) => i).filter((i) => !hasParent.has(i));
  for (const idx of topLevel) {
    if (idx >= 0 && idx < objects.length) root.add(objects[idx]);
  }

  root.updateMatrixWorld(true);
  const skeleton = buildNormalizedSkeleton(root);

  const bonesByName = new Map<string, THREE.Bone>();
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone && !bonesByName.has(obj.name)) {
      bonesByName.set(obj.name, obj as THREE.Bone);
    }
  });

  const skinJointNames = [
    ...new Set(
      (json.skins ?? []).flatMap((s) =>
        (s.joints ?? []).map((j) => nodes[j]?.name ?? `node_${j}`),
      ),
    ),
  ];

  return {
    root,
    skeleton,
    bonesByName,
    skinJointNames,
    gltfVersion: json.asset?.version ?? null,
    generator: json.asset?.generator ?? null,
  };
}

/** Finds a node by name in the reconstructed graph. */
export function findRigObject(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (!found && obj.name === name) found = obj;
  });
  return found;
}
