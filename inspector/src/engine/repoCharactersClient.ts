import type { CharacterSlotId } from './types';

export interface RepoCharacterManifest {
  male: string[];
  female: string[];
}

export async function fetchRepoCharacterManifest(): Promise<RepoCharacterManifest | null> {
  try {
    const res = await fetch('./repo-characters/manifest.json');
    if (!res.ok) return null;
    const data = (await res.json()) as RepoCharacterManifest;
    if (!data || !Array.isArray(data.male) || !Array.isArray(data.female)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function fetchRepoCharacterFiles(
  slot: CharacterSlotId,
  manifestPaths: string[],
): Promise<File[]> {
  const fetchedFiles: File[] = [];
  await Promise.all(
    manifestPaths.map(async (relPath) => {
      const encodedSegments = relPath
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      const res = await fetch(`./repo-characters/${encodedSegments}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch repository asset "${relPath}" (HTTP ${res.status}).`);
      }
      const blob = await res.blob();
      const fileName = relPath.split('/').pop() ?? relPath;
      fetchedFiles.push(
        new File([blob], fileName, {
          type: blob.type || 'application/octet-stream',
        }),
      );
    }),
  );

  // Sort deterministically so .gltf appears first in manifest display
  fetchedFiles.sort((a, b) => {
    const aGltf = a.name.toLowerCase().endsWith('.gltf') ? 0 : 1;
    const bGltf = b.name.toLowerCase().endsWith('.gltf') ? 0 : 1;
    if (aGltf !== bGltf) return aGltf - bGltf;
    return a.name.localeCompare(b.name);
  });

  if (fetchedFiles.length === 0) {
    throw new Error(`No repository files found in Character/${slot === 'male' ? 'Male' : 'Female'}/.`);
  }
  return fetchedFiles;
}
