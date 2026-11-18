/**
 * Loads a repository character into Three.js for animated preview.
 *
 * Kept separate from Phase 1's `inspectCharacter` (which owns structural
 * inspection) so Phase 1 behaviour is untouched: this loader only builds a
 * renderable, skinned scene plus the bone list the retargeter needs.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CharacterSlotId } from './types';
import { fetchRepoCharacterFiles, fetchRepoCharacterManifest } from './repoCharactersClient';
import { buildNormalizedSkeleton } from './fbxSkeleton';
import { basenamePosix, resolveUploadedResource } from './gltfBinaryUtils';
import { snapshotRestPose, type RestPoseSnapshot } from './retarget';

export interface PreviewCharacter {
  slot: CharacterSlotId;
  sceneRoot: THREE.Group;
  bonesByName: Map<string, THREE.Bone>;
  restSnapshot: RestPoseSnapshot;
  /** Height in metres, used for camera framing. */
  height: number;
  /** Textures that could not be resolved from the bundle (never silently ignored). */
  missingTextures: string[];
  /** Textures resolved through the transparent `near_match` fallback. */
  nearMatchedTextures: Array<{ requested: string; resolved: string }>;
  dispose: () => void;
}

function collectBones(root: THREE.Object3D): Map<string, THREE.Bone> {
  const map = new Map<string, THREE.Bone>();
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone && !map.has(obj.name)) map.set(obj.name, obj as THREE.Bone);
  });
  return map;
}

/** Downloads the repository bundle through the Phase 1 client and parses it. */
export async function loadPreviewCharacter(slot: CharacterSlotId): Promise<PreviewCharacter> {
  const manifest = await fetchRepoCharacterManifest();
  if (!manifest) throw new Error('Repository character manifest not found.');
  const paths = slot === 'male' ? manifest.male : manifest.female;
  const files = await fetchRepoCharacterFiles(slot, paths);

  const objectUrls: string[] = [];
  const urlByFile = new Map<File, string>();
  for (const file of files) {
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    urlByFile.set(file, url);
  }

  // Resolve glTF resource URIs with the SAME resolution rules Phase 1 uses
  // (exact path -> basename fallback -> transparent near-match). Without the
  // near-match step the glTF URIs `T_Hair_1_Normal_png.png` / `T_Eye_Normal_png.png`
  // would fail even though the correct bytes are present in the bundle.
  const missingTextures: string[] = [];
  const nearMatchedTextures: Array<{ requested: string; resolved: string }> = [];
  const fallbackTextureUrl = (() => {
    // 1x1 transparent PNG so a missing texture never breaks the whole load.
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0),
    );
    return URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  })();
  objectUrls.push(fallbackTextureUrl);

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    const fileName = basenamePosix(decodeURIComponent(url));
    const resolved = resolveUploadedResource(fileName, '', files);
    if (resolved.file) {
      const blobUrl = urlByFile.get(resolved.file);
      if (resolved.mode === 'near_match' && blobUrl) {
        nearMatchedTextures.push({ requested: fileName, resolved: resolved.file.name });
      }
      if (blobUrl) return blobUrl;
    }
    if (/\.(png|jpe?g|webp|ktx2|basis)$/i.test(fileName)) {
      missingTextures.push(fileName);
      return fallbackTextureUrl;
    }
    // Non-texture resource that could not be resolved: report it explicitly.
    missingTextures.push(fileName);
    return fallbackTextureUrl;
  });

  const loader = new GLTFLoader(manager);
  const gltfFile = files.find((f) => f.name.toLowerCase().endsWith('.gltf'));
  if (!gltfFile) throw new Error('No .gltf file in the character bundle.');

  // Parse from the real glTF text; the URL modifier above maps sibling
  // `.bin` / `.png` requests onto the in-memory File blob URLs.
  const gltfText = await gltfFile.text();
  const parsed = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    loader.parse(gltfText, '', (result) => resolve(result as unknown as { scene: THREE.Group }), (err) => reject(err));
  });

  const sceneRoot = parsed.scene;
  sceneRoot.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(sceneRoot);
  const size = new THREE.Vector3();
  box.getSize(size);

  const bonesByName = collectBones(sceneRoot);
  const restSnapshot = snapshotRestPose(sceneRoot);

  const dispose = () => {
    sceneRoot.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const m of list) {
        for (const key of Object.keys(m) as Array<keyof THREE.Material>) {
          const value = (m as unknown as Record<string, unknown>)[key as string];
          if (value && typeof value === 'object' && 'isTexture' in (value as object)) {
            (value as THREE.Texture).dispose();
          }
        }
        m.dispose();
      }
    });
    for (const url of objectUrls) URL.revokeObjectURL(url);
  };

  return {
    slot,
    sceneRoot,
    bonesByName,
    restSnapshot,
    height: size.y || 1.8,
    missingTextures: [...new Set(missingTextures)],
    nearMatchedTextures,
    dispose,
  };
}

/** Builds a normalized skeleton from a loaded preview character (for analysis parity). */
export function previewSkeleton(character: PreviewCharacter) {
  return buildNormalizedSkeleton(character.sceneRoot);
}
