import { describe, expect, it } from 'vitest';
import { parseFbxAnimation } from '../src/engine/fbxSkeleton';
import { buildCharacterRigFromGltf, type CharacterRig } from '../src/engine/characterRig';
import { analyzeCompatibility, buildMappings } from '../src/engine/compatibility';
import type { CompatibilityReport, ParsedAnimationResult } from '../src/engine/animationTypes';
import { malformedFbxBuffer, readAnimationBuffer, readGltfJson } from './phase2Fixtures';

const maleRig: CharacterRig = buildCharacterRigFromGltf(readGltfJson('Male') as never);
const femaleRig: CharacterRig = buildCharacterRigFromGltf(readGltfJson('Female') as never);

function parse(fileName: string): ParsedAnimationResult {
  return parseFbxAnimation(readAnimationBuffer(fileName), {
    assetId: `animations/${fileName}`,
    sourcePath: `animations/${fileName}`,
    fileName,
    sha256: `sha-${fileName}`,
  });
}

function report(fileName: string, slot: 'male' | 'female'): CompatibilityReport {
  const rig = slot === 'male' ? maleRig : femaleRig;
  return analyzeCompatibility({
    animation: parse(fileName),
    characterSlot: slot,
    characterSkeleton: rig.skeleton,
  });
}

describe('Phase 2 — character rig reconstruction', () => {
  it('rebuilds both characters with 65 joints and the expected hierarchy', () => {
    for (const [rig, slot] of [[maleRig, 'male'], [femaleRig, 'female']] as const) {
      expect(rig.skeleton.boneCount, slot).toBe(65);
      expect(rig.skinJointNames.length, slot).toBe(65);
      expect(rig.skeleton.rootBoneNames).toEqual(['root']);
      expect(rig.skeleton.duplicateBoneNames).toEqual([]);
      expect(rig.gltfVersion).toBe('2.0');
    }
    // Both characters share the same joint naming convention.
    expect(maleRig.skeleton.bones.map((b) => b.name)).toEqual(femaleRig.skeleton.bones.map((b) => b.name));
  });

  it('maps every required humanoid slot on both characters', () => {
    for (const rig of [maleRig, femaleRig]) {
      const { characterMatches } = buildMappings(rig.skeleton, rig.skeleton);
      const required = Object.values(characterMatches).filter((m) => m.bone);
      expect(required.length).toBe(32);
      expect(characterMatches.hips.bone).toBe('pelvis');
      expect(characterMatches.head.bone).toBe('Head');
    }
  });
});

describe('Phase 2 — compatibility scoring (real animations)', () => {
  it('scores a real Mixamo walk as compatible or compatible-with-warnings for Male', () => {
    const r = report('walk forward.fbx', 'male');
    expect(['COMPATIBLE', 'COMPATIBLE_WITH_WARNINGS']).toContain(r.status);
    expect(r.scoring.requiredSlotsMapped).toBe(r.scoring.requiredSlotsTotal);
    expect(r.requiredBonesMissing).toEqual([]);
    expect(r.retargetReadiness === 'ready' || r.retargetReadiness === 'ready_with_warnings').toBe(true);
    expect(r.limitations.join(' ')).toMatch(/NOT Unity/i);
  });

  it('produces a separate report per character with the same inputs', () => {
    const male = report('run forward.fbx', 'male');
    const female = report('run forward.fbx', 'female');
    expect(male.characterSlot).toBe('male');
    expect(female.characterSlot).toBe('female');
    expect(male.scoring.requiredSlotsTotal).toBe(female.scoring.requiredSlotsTotal);
    // Both rigs share naming, so coverage must agree.
    expect(male.scoring.requiredSlotsMapped).toBe(female.scoring.requiredSlotsMapped);
  });

  it('reports PROCESSING_FAILED for a genuinely malformed FBX (synthetic fixture)', () => {
    // NOTE: `reloading.fbx` used to be asserted here. It turned out to be a VALID
    // asset that three.js's hardcoded 176-byte footer budget rejected — see
    // engine/fbxLoaderTolerant.ts and tests/phase2.fbxTolerance.test.ts. Genuine
    // parse failure is now covered with a deliberately corrupt buffer instead.
    const corrupt = parseFbxAnimation(malformedFbxBuffer(), {
      assetId: 'corrupt',
      sourcePath: 'animations/corrupt.fbx',
      fileName: 'corrupt.fbx',
      sha256: 'x',
    });
    expect(corrupt.status).toBe('failed');

    const failedReport = analyzeCompatibility({
      animation: corrupt,
      characterSlot: 'male',
      characterSkeleton: maleRig.skeleton,
    });
    expect(failedReport.status).toBe('PROCESSING_FAILED');
    expect(failedReport.retargetReadiness).toBe('not_ready');
    expect(failedReport.issues[0].code).toBe('ANIMATION_PARSE_FAILED');
  });

  it('scores the two previously-rejected assets as usable (footer-tolerance regression)', () => {
    for (const file of ['death from the back.fbx', 'reloading.fbx']) {
      const r = report(file, 'male');
      expect(r.status).not.toBe('PROCESSING_FAILED');
      expect(r.retargetReadiness).not.toBe('not_ready');
    }
  });

  it('exposes a transparent rule trace rather than an opaque score', () => {
    const r = report('idle.fbx', 'female');
    expect(r.scoring.ruleTrace.length).toBeGreaterThanOrEqual(5);
    expect(r.scoring.ruleTrace.join(' ')).toMatch(/Required slot coverage/);
    expect(r.scoring.ruleTrace.join(' ')).toMatch(/Hierarchy validation/);
    expect(r.scoring.ruleTrace.join(' ')).toMatch(/Track matching/);
    expect(r.scoring.ruleTrace.some((t) => t.startsWith('Verdict '))).toBe(true);
  });

  it('validates parent-child hierarchy across the humanoid chain', () => {
    const r = report('walking.fbx', 'male');
    expect(r.hierarchy.checkedParents).toBeGreaterThan(15);
    expect(r.hierarchy.validParents).toBe(r.hierarchy.checkedParents);
    expect(r.hierarchy.mismatches).toEqual([]);
  });

  it('validates left/right sides with no violations on a Mixamo rig', () => {
    const r = report('walking.fbx', 'male');
    expect(r.sideValidation.checked).toBeGreaterThan(10);
    expect(r.sideValidation.violations).toEqual([]);
  });

  it('matches animation tracks to mapped bones', () => {
    const r = report('walk forward.fbx', 'male');
    expect(r.trackAnalysis.totalTracks).toBeGreaterThan(40);
    expect(r.trackAnalysis.matchedTracks).toBeGreaterThan(25);
    expect(r.trackAnalysis.matchedBones).toContain('mixamorigHips');
  });

  it('records rest-pose divergence as data, not a pass/fail claim', () => {
    const r = report('idle.fbx', 'male');
    expect(r.restPose.maxRestRotationDeltaDeg).not.toBeNull();
    expect(r.restPose.maxRestRotationDeltaDeg!).toBeGreaterThanOrEqual(0);
    expect(r.restPose.maxLimbLengthDeviationRatio).not.toBeNull();
  });

  it('gives an INCOMPATIBLE verdict to a rig missing required bones', () => {
    // Synthetic animation skeleton with only a spine chain.
    const anim = parse('idle.fbx');
    const crippled: ParsedAnimationResult = {
      ...anim,
      skeleton: {
        ...anim.skeleton!,
        bones: anim.skeleton!.bones.filter((b) =>
          ['mixamorigHips', 'mixamorigSpine'].includes(b.name),
        ).map((b, i) => ({ ...b, index: i, parentIndex: b.name === 'mixamorigSpine' ? 0 : null })),
        boneCount: 2,
      },
    };
    const r = analyzeCompatibility({ animation: crippled, characterSlot: 'male', characterSkeleton: maleRig.skeleton });
    expect(r.status).toBe('INCOMPATIBLE');
    expect(r.requiredBonesMissing.length).toBeGreaterThan(5);
    expect(r.retargetReadiness).toBe('not_ready');
  });
});
