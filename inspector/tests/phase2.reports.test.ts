import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildDiscoveryReport, type DiscoveredFile } from '../src/engine/animationDiscovery';
import { buildCharacterRigFromGltf } from '../src/engine/characterRig';
import { runPhase2 } from '../src/engine/phase2Pipeline';
import {
  buildAnalysisBundle,
  buildAnimationAnalysisReport,
  buildBoneMappingsReport,
  buildCharacterCompatibilityReport,
  buildHtmlSummary,
  buildValidationReport,
} from '../src/engine/animationReports';
import { animationFileNames, animationsDir, readGltfJson } from './phase2Fixtures';

const discovery = buildDiscoveryReport(
  animationFileNames().map<DiscoveredFile>((name) => {
    const bytes = fs.readFileSync(path.join(animationsDir, name));
    return {
      path: `animations/${name}`,
      sizeBytes: bytes.byteLength,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }),
);

const buffers = new Map<string, ArrayBuffer>();
for (const name of animationFileNames()) {
  const buf = fs.readFileSync(path.join(animationsDir, name));
  buffers.set(`animations/${name}`, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

const maleRig = buildCharacterRigFromGltf(readGltfJson('Male') as never);
const femaleRig = buildCharacterRigFromGltf(readGltfJson('Female') as never);

async function fullRun() {
  return runPhase2({
    discovery,
    buffers,
    maleRig,
    femaleRig,
    only: ['animations/idle.fbx', 'animations/walk forward.fbx', 'animations/reloading.fbx'],
    useWorker: false,
  });
}

describe('Phase 2 — report generation', () => {
  it('animation-analysis.json lists assets, statuses and clip data', async () => {
    const run = await fullRun();
    const report = buildAnimationAnalysisReport(run.bundle);

    expect(report.report).toBe('animation-analysis');
    expect(report.discovery.expectedCount).toBe(74);
    expect(report.discovery.matchesExpectedCount).toBe(true);

    const idle = report.assets.find((a) => a.fileName === 'idle.fbx')!;
    expect(idle.status).toBe('ok');
    expect(idle.boneCount).toBe(65);
    expect(idle.clips.length).toBe(1);
    expect(idle.clips[0].durationSeconds).toBeGreaterThan(0);
    expect(idle.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(idle.detectedHumanoidSlots).length).toBeGreaterThan(20);

    const bad = report.assets.find((a) => a.fileName === 'reloading.fbx')!;
    expect(bad.status).toBe('failed');
    expect(bad.error).toBeTruthy();
  }, 60000);

  it('character-compatibility.json contains a report per character with required fields', async () => {
    const run = await fullRun();
    const report = buildCharacterCompatibilityReport(run.bundle);

    expect(report.report).toBe('character-compatibility');
    expect(report.reports.length).toBe(3 * 2);
    expect(report.summary.byCharacter).toEqual({ male: 3, female: 3 });

    for (const r of report.reports) {
      expect(r.sourceAnimation).toBeTruthy();
      expect(r.sourcePath).toMatch(/^animations\//);
      expect(['male', 'female']).toContain(r.characterTarget);
      expect(r.compatibilityStatus).toBeTruthy();
      expect(Array.isArray(r.requiredBonesFound)).toBe(true);
      expect(Array.isArray(r.requiredBonesMissing)).toBe(true);
      expect(r.scoring.ruleTrace.length).toBeGreaterThan(0);
      expect(r.limitations.join(' ')).toMatch(/NOT Unity/i);
    }

    // The walk must be a usable verdict on both characters.
    const walkMale = report.reports.find(
      (r) => r.sourceAnimation === 'walk forward.fbx' && r.characterTarget === 'male',
    )!;
    expect(['COMPATIBLE', 'COMPATIBLE_WITH_WARNINGS', 'PARTIALLY_COMPATIBLE']).toContain(
      walkMale.compatibilityStatus,
    );
    expect(walkMale.requiredBonesMissing).toEqual([]);
  }, 60000);

  it('bone-mappings.json exposes inspectable, reusable profiles', async () => {
    const run = await fullRun();
    const report = buildBoneMappingsReport(run.bundle);

    expect(report.report).toBe('bone-mappings');
    expect(report.profiles.length).toBe(2 * 2); // idle + walk, per character

    for (const profile of report.profiles) {
      expect(profile.id).toContain('::');
      expect(profile.entries.length).toBe(32);
      expect(profile.animationSignature).toBeTruthy();
      expect(profile.characterSignature).toMatch(/^(male|female):/);
      expect(profile.manuallyAdjusted).toBe(false);

      for (const entry of profile.entries) {
        expect(entry.slot).toBeTruthy();
        expect(['exact', 'alias', 'hierarchy', 'unresolved', 'manual']).toContain(entry.method);
        expect(entry.confidence).toBeGreaterThanOrEqual(0);
        expect(entry.confidence).toBeLessThanOrEqual(1);
      }

      // Every profile maps hips correctly.
      expect(profile.entries.find((e) => e.slot === 'hips')!.characterBone).toBe('pelvis');
    }
  }, 60000);

  it('animation-validation-report.json asserts pass/fail checks', async () => {
    const run = await fullRun();
    const report = buildValidationReport(run.bundle, {
      unchangedAssetsVerified: true,
      phase1TestsPassing: true,
      phase2TestsPassing: true,
    });

    expect(report.report).toBe('animation-validation');
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    expect(byId.get('discovery.expected_count')!.passed).toBe(true);
    expect(byId.get('discovery.no_character_fbx')!.passed).toBe(true);
    expect(byId.get('parsing.malformed_isolated')!.passed).toBe(true);
    expect(byId.get('compatibility.male_reports')!.passed).toBe(true);
    expect(byId.get('compatibility.female_reports')!.passed).toBe(true);
    expect(byId.get('retarget.ready_male')!.passed).toBe(true);
    expect(byId.get('retarget.ready_female')!.passed).toBe(true);
    expect(byId.get('mappings.profiles')!.passed).toBe(true);
    expect(byId.get('integrity.source_assets_unchanged')!.passed).toBe(true);

    expect(report.totals.discovered).toBe(74);
    expect(report.totals.processed).toBe(3);
    expect(report.totals.parsedOk).toBe(2);
    expect(report.totals.failed).toBe(1);
  }, 60000);

  it('the validation report fails loudly when the expected count is wrong', () => {
    const bundle = buildAnalysisBundle({
      discovery: { ...discovery, animationFiles: 70, matchesExpectedCount: false },
      animations: [],
      compatibility: [],
      mappings: [],
      characterSignatures: { male: 'male', female: 'female' },
    });
    const report = buildValidationReport(bundle, {
      unchangedAssetsVerified: false,
      phase1TestsPassing: false,
      phase2TestsPassing: false,
    });
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(byId.get('discovery.expected_count')!.passed).toBe(false);
    expect(byId.get('retarget.ready_male')!.passed).toBe(false);
    expect(byId.get('integrity.source_assets_unchanged')!.passed).toBe(false);
  });

  it('builds a readable HTML summary with the honest limitations', async () => {
    const run = await fullRun();
    const html = buildHtmlSummary(run.bundle);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Phase 2 — Animation Compatibility Inspector');
    expect(html).toContain('Not Unity Editor');
    expect(html).toContain('AvatarBuilder');
    expect(html).toContain('idle.fbx');
    expect(html).toContain('walk forward.fbx');
    // The malformed asset is surfaced, not hidden.
    expect(html).toContain('reloading.fbx');
    expect(html).toContain('74');
    expect(html).toContain('Limitations');
    // No unescaped interpolation leaks.
    expect(html).not.toContain('[object Object]');
  }, 60000);

  it('reports carry the source filename, target and verdict for every pair', async () => {
    const run = await fullRun();
    const compat = buildCharacterCompatibilityReport(run.bundle);
    for (const r of compat.reports) {
      expect(r.sourceAnimation.endsWith('.fbx')).toBe(true);
      expect(['male', 'female']).toContain(r.characterTarget);
      expect(r.compatibilityStatus).toBeTruthy();
      expect(Array.isArray(r.warnings)).toBe(true);
      expect(Array.isArray(r.issues)).toBe(true);
    }
  }, 60000);
});
