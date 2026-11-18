import fs from 'node:fs';
import path from 'node:path';
import { File as NodeFile } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectCharacterBundle } from '../src/engine/inspectCharacter';
import { buildFixtureBundle, FULL_HUMANOID_BONES, FULL_HUMANOID_PARENTS, makeFile } from './gltfFixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function readRepoFiles(subDir: string): File[] {
  const dir = path.join(repoRoot, 'Character', subDir);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.trim() !== '. gitkeep')
    .map((e) => {
      const buf = fs.readFileSync(path.join(dir, e.name));
      const type = e.name.endsWith('.gltf') ? 'model/gltf+json' : e.name.endsWith('.png') ? 'image/png' : e.name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream';
      return new NodeFile([new Uint8Array(buf) as never], e.name, { type }) as unknown as File;
    });
}

describe('Phase 1 synthetic glTF fixtures', () => {
  it('1. no skeleton -> SKELETON_MISSING', async () => {
    const session = await inspectCharacterBundle(buildFixtureBundle({ boneNames: [] }), 'male', 'Test');
    expect(session.report.statuses.skeleton).toBe('Missing');
    expect(session.report.statuses.skinnedMesh).toBe('Missing');
    expect(session.report.finalClassification).toBe('SKELETON_MISSING');
    session.dispose();
  });

  it('2. valid skeleton + SkinnedMesh -> RIGGED_AND_SKINNED', async () => {
    const session = await inspectCharacterBundle(buildFixtureBundle({}), 'male', 'Test');
    expect(session.report.statuses.skeleton).toBe('Present');
    expect(session.report.statuses.skinnedMesh).toBe('Present');
    expect(session.report.statuses.boneWeights).toBe('Valid');
    expect(session.report.statuses.bindPose).toBe('Available');
    expect(session.report.finalClassification).toBe('RIGGED_AND_SKINNED');
    expect(session.report.skeletons[0].totalBoneCount).toBe(19);
    session.dispose();
  });

  it('3. skeleton present but not skinned', async () => {
    const session = await inspectCharacterBundle(buildFixtureBundle({ skinned: false }), 'female', 'Test');
    expect(session.report.statuses.skeleton).toBe('Present');
    expect(session.report.statuses.skinnedMesh).toBe('Missing');
    expect(session.report.finalClassification).toBe('SKELETON_PRESENT_BUT_NOT_SKINNED');
    session.dispose();
  });

  it('4. missing BIN -> INVALID_OR_INCOMPLETE_GLTF with buffer error', async () => {
    const session = await inspectCharacterBundle(buildFixtureBundle({ omitBin: true }), 'male', 'Test');
    expect(session.report.finalClassification).toBe('INVALID_OR_INCOMPLETE_GLTF');
    expect(session.report.buffers.some((b) => b.status === 'missing')).toBe(true);
    session.dispose();
  });

  it('5. missing external texture -> Textures Missing, skeleton still inspected', async () => {
    const session = await inspectCharacterBundle(
      buildFixtureBundle({ textureUri: 'T_Missing.png', omitTexture: true }), 'male', 'Test',
    );
    expect(session.report.statuses.textures).toBe('Missing');
    expect(session.report.textures[0].status).toBe('missing');
    expect(session.report.statuses.skeleton).toBe('Present');
    session.dispose();
  });

  it('6. invalid skin indices (out of range) -> Bone Weights Invalid', async () => {
    const session = await inspectCharacterBundle(
      buildFixtureBundle({ jointsOverride: [99, 0, 0, 0, 99, 0, 0, 0, 99, 0, 0, 0, 99, 0, 0, 0] }),
      'male', 'Test',
    );
    expect(session.report.statuses.boneWeights).toBe('Invalid');
    expect(session.report.skinning.outOfRangeJointVertices).toBeGreaterThan(0);
    expect(session.report.finalClassification).toBe('SKELETON_PRESENT_WITH_WEIGHT_ISSUES');
    session.dispose();
  });

  it('7. unnormalized weights -> Bone Weights Invalid + normalization required', async () => {
    const session = await inspectCharacterBundle(
      buildFixtureBundle({ weightsOverride: [0.25, 0.25, 0, 0, 0.25, 0.25, 0, 0, 0.25, 0.25, 0, 0, 0.25, 0.25, 0, 0] }),
      'male', 'Test',
    );
    expect(session.report.statuses.boneWeights).toBe('Invalid');
    expect(session.report.skinning.requiresWeightNormalization).toBe(true);
    expect(session.report.skinning.unnormalizedVertices).toBeGreaterThan(0);
    session.dispose();
  });

  it('7b. negative weights -> Bone Weights Invalid', async () => {
    const session = await inspectCharacterBundle(
      buildFixtureBundle({ weightsOverride: [-0.5, 1.5, 0, 0, -0.5, 1.5, 0, 0, -0.5, 1.5, 0, 0, -0.5, 1.5, 0, 0] }),
      'male', 'Test',
    );
    expect(session.report.statuses.boneWeights).toBe('Invalid');
    expect(session.report.skinning.negativeWeightVertices).toBeGreaterThan(0);
    session.dispose();
  });

  it('8. duplicate bone names -> Bone Hierarchy Issues Found', async () => {
    const names = [...FULL_HUMANOID_BONES];
    names[2] = 'Spine'; // duplicate of index 1
    const session = await inspectCharacterBundle(
      buildFixtureBundle({ boneNames: names, parents: FULL_HUMANOID_PARENTS }), 'male', 'Test',
    );
    expect(session.report.skeletons[0].duplicateBoneNames).toContain('Spine');
    expect(session.report.statuses.boneHierarchy).toBe('Issues Found');
    session.dispose();
  });

  it('9. incomplete humanoid skeleton -> Humanoid Incomplete', async () => {
    const session = await inspectCharacterBundle(
      buildFixtureBundle({ boneNames: ['Hips', 'Spine', 'Head'], parents: [null, 0, 1] }),
      'female', 'Test',
    );
    expect(session.report.statuses.humanoidStructure).toBe('Incomplete');
    expect(session.report.humanoid.missingCount).toBeGreaterThan(0);
    session.dispose();
  });

  it('10. valid humanoid-like skeleton -> Humanoid Likely, all core slots Found', async () => {
    const session = await inspectCharacterBundle(buildFixtureBundle({}), 'female', 'Test');
    expect(session.report.statuses.humanoidStructure).toBe('Likely');
    const core = session.report.humanoid.slots.filter((s) => s.isCoreBipedalSlot);
    expect(core.every((s) => s.status === 'Found' || s.status === 'Possible match')).toBe(true);
    expect(session.report.humanoid.foundCount).toBeGreaterThanOrEqual(15);
    session.dispose();
  });

  it('invalid JSON -> INVALID_OR_INCOMPLETE_GLTF without throwing', async () => {
    const session = await inspectCharacterBundle(
      buildFixtureBundle({ rawGltfText: '{not json' }), 'male', 'Test',
    );
    expect(session.report.finalClassification).toBe('INVALID_OR_INCOMPLETE_GLTF');
    session.dispose();
  });

  it('licence.txt companion file is summarised, never mutated', async () => {
    const licence = makeFile('License_Standard.txt', 'Test licence line one\nLine two\n', 'text/plain');
    const session = await inspectCharacterBundle(buildFixtureBundle({ extraFiles: [licence] }), 'male', 'Test');
    expect(session.report.licence.present).toBe(true);
    expect(session.report.licence.fileName).toBe('License_Standard.txt');
    expect(await licence.text()).toBe('Test licence line one\nLine two\n');
    session.dispose();
  });
});

describe('repository Character bundles (Character/Male + Character/Female)', () => {
  it('Male Superhero_Male_FullBody: rigged + skinned, 65 Unreal-Mannequin joints', async () => {
    const files = readRepoFiles('Male');
    expect(files.some((f) => f.name === 'Superhero_Male_FullBody.gltf')).toBe(true);
    const session = await inspectCharacterBundle(files, 'male', 'Repository Character/Male');
    expect(session.report.primaryGltfFileName).toBe('Superhero_Male_FullBody.gltf');
    expect(session.report.statuses.skeleton).toBe('Present');
    expect(session.report.statuses.skinnedMesh).toBe('Present');
    expect(session.report.statuses.boneWeights).toBe('Valid');
    expect(session.report.statuses.bindPose).toBe('Available');
    expect(session.report.finalClassification).toBe('RIGGED_AND_SKINNED');
    expect(session.report.skeletons[0].totalBoneCount).toBe(65);
    expect(session.report.skeletons[0].boneNames).toContain('pelvis');
    expect(session.report.skeletons[0].boneNames).toContain('Head');
    expect(session.report.licence.present).toBe(true);
    // 7 textures referenced, 3 present in repo, 4 missing (hair/eye) -> Missing
    expect(session.report.textures.length).toBe(7);
    expect(session.report.textures.filter((t) => t.status === 'loaded').length).toBe(3);
    expect(session.report.statuses.textures).toBe('Missing');
    session.dispose();
  });

  it('Female Superhero_Female_FullBody: rigged + skinned, 65 Unreal-Mannequin joints', async () => {
    const files = readRepoFiles('Female');
    expect(files.some((f) => f.name === 'Superhero_Female_FullBody.gltf')).toBe(true);
    const session = await inspectCharacterBundle(files, 'female', 'Repository Character/Female');
    expect(session.report.primaryGltfFileName).toBe('Superhero_Female_FullBody.gltf');
    expect(session.report.statuses.skeleton).toBe('Present');
    expect(session.report.statuses.skinnedMesh).toBe('Present');
    expect(session.report.statuses.boneWeights).toBe('Valid');
    expect(session.report.finalClassification).toBe('RIGGED_AND_SKINNED');
    expect(session.report.skeletons[0].totalBoneCount).toBe(65);
    expect(session.report.textures.length).toBe(7);
    expect(session.report.textures.filter((t) => t.status === 'loaded').length).toBe(3);
    expect(session.report.statuses.textures).toBe('Missing');
    session.dispose();
  });
});
