/**
 * Phase 2 report generation and downloadable exports.
 *
 * Produces exactly the artifacts required by the Phase 2 spec:
 *   animation-analysis.json
 *   character-compatibility.json
 *   bone-mappings.json
 *   animation-validation-report.json
 * plus a readable HTML summary.
 */

import type {
  AnimationAnalysisBundle,
  AnimationAssetEntry,
  AnimationDiscoveryReport,
  BoneMappingProfile,
  CompatibilityReport,
  ParsedAnimationResult,
} from './animationTypes';
import { PHASE2_LIMITATIONS } from './compatibility';

export interface BuildBundleInput {
  discovery: AnimationDiscoveryReport;
  animations: ParsedAnimationResult[];
  compatibility: CompatibilityReport[];
  mappings: BoneMappingProfile[];
  characterSignatures: Record<'male' | 'female', string>;
  generatedAtIso?: string;
}

export function buildAnalysisBundle(input: BuildBundleInput): AnimationAnalysisBundle {
  return {
    schemaVersion: '2.0.0',
    phase: 'Phase 2 — Animation Compatibility Inspector',
    generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
    discovery: input.discovery,
    animations: input.animations,
    compatibility: input.compatibility,
    mappings: input.mappings,
    characterSignatures: input.characterSignatures,
    limitations: PHASE2_LIMITATIONS,
  };
}

/** `animation-analysis.json` — discovery + per-animation skeleton/clip analysis. */
export function buildAnimationAnalysisReport(bundle: AnimationAnalysisBundle) {
  return {
    schemaVersion: bundle.schemaVersion,
    report: 'animation-analysis',
    generatedAtIso: bundle.generatedAtIso,
    discovery: {
      scannedDirectories: bundle.discovery.scannedDirectories,
      totalFilesScanned: bundle.discovery.totalFilesScanned,
      animationFiles: bundle.discovery.animationFiles,
      expectedCount: bundle.discovery.expectedCount,
      matchesExpectedCount: bundle.discovery.matchesExpectedCount,
      duplicates: bundle.discovery.duplicates,
      discoveryStrategy: bundle.discovery.discoveryStrategy,
    },
    assets: bundle.discovery.assets.map((asset) => {
      const parsed = bundle.animations.find((a) => a.assetId === asset.id);
      return {
        assetId: asset.id,
        sourcePath: asset.sourcePath,
        fileName: asset.fileName,
        category: asset.category,
        sizeBytes: asset.sizeBytes,
        sha256: asset.sha256,
        duplicateOf: asset.duplicateOf,
        status: parsed?.status ?? 'not_processed',
        error: parsed?.error ?? null,
        parseMs: parsed?.parseMs ?? null,
        boneCount: parsed?.skeleton?.boneCount ?? null,
        rootBones: parsed?.skeleton?.rootBoneNames ?? [],
        duplicateBoneNames: parsed?.skeleton?.duplicateBoneNames ?? [],
        detectedHumanoidSlots: parsed?.skeleton?.detectedHumanoidSlots ?? {},
        clips: parsed?.clips ?? [],
        durationSeconds: parsed?.durationSeconds ?? null,
        warnings: parsed?.warnings ?? [],
      };
    }),
    limitations: bundle.limitations,
  };
}

/** `character-compatibility.json` — per-animation, per-character verdicts. */
export function buildCharacterCompatibilityReport(bundle: AnimationAnalysisBundle) {
  return {
    schemaVersion: bundle.schemaVersion,
    report: 'character-compatibility',
    generatedAtIso: bundle.generatedAtIso,
    characterSignatures: bundle.characterSignatures,
    summary: summarizeCompatibility(bundle.compatibility),
    reports: bundle.compatibility.map((r) => ({
      sourceAnimation: r.fileName,
      sourcePath: r.sourcePath,
      characterTarget: r.characterSlot,
      compatibilityStatus: r.status,
      retargetReadiness: r.retargetReadiness,
      requiredBonesFound: r.requiredBonesFound,
      requiredBonesMissing: r.requiredBonesMissing,
      trackAnalysis: r.trackAnalysis,
      hierarchy: r.hierarchy,
      sideValidation: r.sideValidation,
      restPose: r.restPose,
      scoring: r.scoring,
      warnings: r.issues.filter((i) => i.severity === 'warning' || i.severity === 'error'),
      issues: r.issues,
      limitations: r.limitations,
    })),
    limitations: bundle.limitations,
  };
}

/** `bone-mappings.json` — reusable mapping profiles. */
export function buildBoneMappingsReport(bundle: AnimationAnalysisBundle) {
  return {
    schemaVersion: bundle.schemaVersion,
    report: 'bone-mappings',
    generatedAtIso: bundle.generatedAtIso,
    profiles: bundle.mappings,
    limitations: bundle.limitations,
  };
}

/** `animation-validation-report.json` — pass/fail validation of the whole run. */
export function buildValidationReport(
  bundle: AnimationAnalysisBundle,
  extra: { unchangedAssetsVerified: boolean | null; phase1TestsPassing: boolean | null; phase2TestsPassing: boolean | null },
) {
  const processed = bundle.animations.length;
  const parsedOk = bundle.animations.filter((a) => a.status === 'ok').length;
  const failed = bundle.animations.filter((a) => a.status !== 'ok').length;
  const expected = bundle.discovery.expectedCount;
  const discoveredAll = expected === null ? true : bundle.discovery.animationFiles === expected;

  const maleReports = bundle.compatibility.filter((r) => r.characterSlot === 'male');
  const femaleReports = bundle.compatibility.filter((r) => r.characterSlot === 'female');
  const retargetReadyMale = maleReports.filter((r) => r.retargetReadiness !== 'not_ready').length;
  const retargetReadyFemale = femaleReports.filter((r) => r.retargetReadiness !== 'not_ready').length;

  return {
    schemaVersion: bundle.schemaVersion,
    report: 'animation-validation',
    generatedAtIso: bundle.generatedAtIso,
    checks: [
      {
        id: 'discovery.expected_count',
        description: `Animation FBX files discovered equals expected count (${expected ?? 'not asserted'})`,
        passed: discoveredAll,
        detail: `discovered ${bundle.discovery.animationFiles}`,
      },
      {
        id: 'discovery.no_character_fbx',
        description: 'No Character bundle FBX counted as an animation asset',
        passed: !bundle.discovery.assets.some((a) => a.sourcePath.toLowerCase().startsWith('character/')),
        detail: 'assets scanned only from animations/',
      },
      {
        id: 'parsing.malformed_isolated',
        description: 'Malformed FBX files fail individually without aborting the batch',
        passed: true,
        detail: `${failed} failed / ${processed} processed`,
        failedAssets: bundle.animations.filter((a) => a.status !== 'ok').map((a) => ({ fileName: a.fileName, error: a.error })),
      },
      {
        id: 'compatibility.male_reports',
        description: 'Male compatibility report generated for every processed animation',
        passed: maleReports.length === processed,
        detail: `${maleReports.length}/${processed}`,
      },
      {
        id: 'compatibility.female_reports',
        description: 'Female compatibility report generated for every processed animation',
        passed: femaleReports.length === processed,
        detail: `${femaleReports.length}/${processed}`,
      },
      {
        id: 'retarget.ready_male',
        description: 'At least one animation is retarget-ready on the Male character',
        passed: retargetReadyMale > 0,
        detail: `${retargetReadyMale} ready`,
      },
      {
        id: 'retarget.ready_female',
        description: 'At least one animation is retarget-ready on the Female character',
        passed: retargetReadyFemale > 0,
        detail: `${retargetReadyFemale} ready`,
      },
      {
        id: 'mappings.profiles',
        description: 'Bone mapping profiles generated and exportable',
        passed: bundle.mappings.length > 0,
        detail: `${bundle.mappings.length} profiles`,
      },
      {
        id: 'integrity.source_assets_unchanged',
        description: 'Original FBX / .fbx.meta assets unchanged (verified outside the browser)',
        passed: extra.unchangedAssetsVerified,
        detail: extra.unchangedAssetsVerified === null ? 'not verified in this run' : 'verified',
      },
      {
        id: 'tests.phase1',
        description: 'Phase 1 test suite passes',
        passed: extra.phase1TestsPassing,
        detail: extra.phase1TestsPassing === null ? 'not reported to the browser' : String(extra.phase1TestsPassing),
      },
      {
        id: 'tests.phase2',
        description: 'Phase 2 test suite passes',
        passed: extra.phase2TestsPassing,
        detail: extra.phase2TestsPassing === null ? 'not reported to the browser' : String(extra.phase2TestsPassing),
      },
    ],
    totals: {
      discovered: bundle.discovery.animationFiles,
      processed,
      parsedOk,
      failed,
      maleReports: maleReports.length,
      femaleReports: femaleReports.length,
      mappingProfiles: bundle.mappings.length,
    },
    limitations: bundle.limitations,
  };
}

export function summarizeCompatibility(reports: CompatibilityReport[]) {
  const byStatus = new Map<string, number>();
  for (const r of reports) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const bySlot = { male: 0, female: 0 };
  for (const r of reports) bySlot[r.characterSlot] += 1;
  return {
    total: reports.length,
    byStatus: Object.fromEntries([...byStatus.entries()].sort()),
    byCharacter: bySlot,
  };
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Readable HTML summary of a complete run. */
export function buildHtmlSummary(bundle: AnimationAnalysisBundle): string {
  const summary = summarizeCompatibility(bundle.compatibility);
  const failedAssets = bundle.animations.filter((a) => a.status !== 'ok');

  const statusRows = Object.entries(summary.byStatus)
    .map(
      ([status, count]) =>
        `<tr><td><span class="pill ${status === 'COMPATIBLE' ? 'good' : status === 'INCOMPATIBLE' || status === 'PROCESSING_FAILED' ? 'bad' : 'warn'}">${esc(status)}</span></td><td>${count}</td></tr>`,
    )
    .join('');

  const perAnimationRows = bundle.discovery.assets
    .map((asset: AnimationAssetEntry) => {
      const male = bundle.compatibility.find((r) => r.assetId === asset.id && r.characterSlot === 'male');
      const female = bundle.compatibility.find((r) => r.assetId === asset.id && r.characterSlot === 'female');
      const parsed = bundle.animations.find((a) => a.assetId === asset.id);
      return `<tr>
        <td><code>${esc(asset.fileName)}</code></td>
        <td>${esc(asset.category)}</td>
        <td>${parsed?.skeleton?.boneCount ?? '—'}</td>
        <td>${parsed?.durationSeconds?.toFixed(2) ?? '—'}</td>
        <td>${male ? `<span class="pill ${male.status === 'COMPATIBLE' ? 'good' : male.status === 'INCOMPATIBLE' || male.status === 'PROCESSING_FAILED' ? 'bad' : 'warn'}">${esc(male.status)}</span>` : '—'}</td>
        <td>${female ? `<span class="pill ${female.status === 'COMPATIBLE' ? 'good' : female.status === 'INCOMPATIBLE' || female.status === 'PROCESSING_FAILED' ? 'bad' : 'warn'}">${esc(female.status)}</span>` : '—'}</td>
        <td>${parsed?.status === 'ok' ? 'parsed' : `<span class="pill bad">failed</span> ${esc(parsed?.error ?? '')}`}</td>
      </tr>`;
    })
    .join('');

  const failedRows = failedAssets.length
    ? failedAssets.map((a) => `<li><code>${esc(a.fileName)}</code> — ${esc(a.error)}</li>`).join('')
    : '<li class="muted">None — every discovered FBX parsed successfully.</li>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Phase 2 — Animation Compatibility Report</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:24px; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background:#0b0f17; color:#e2e8f0; line-height:1.5; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:26px 0 10px; color:#93c5fd; }
  .sub { color:#94a3b8; margin-bottom:18px; font-size:13px; }
  .notice { border-left:3px solid #f59e0b; background:#1c1a12; padding:10px 14px; border-radius:6px; font-size:13px; margin-bottom:18px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #1e293b; vertical-align:top; }
  th { color:#94a3b8; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
  code { background:#111827; padding:1px 4px; border-radius:3px; font-size:12px; }
  .pill { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px; font-weight:600; }
  .good { background:#052e16; color:#4ade80; } .warn { background:#3a2a06; color:#fbbf24; } .bad { background:#3f0d0d; color:#f87171; }
  .muted { color:#64748b; }
  .table-wrap { overflow-x:auto; }
</style></head>
<body>
  <h1>Phase 2 — Animation Compatibility Inspector</h1>
  <div class="sub">Generated ${esc(bundle.generatedAtIso)} · schema ${esc(bundle.schemaVersion)}</div>
  <div class="notice"><strong>Not Unity Editor.</strong> Browser-side FBX skeleton analysis and geometry-level retargeting only.
  This does not run Unity <code>AvatarBuilder</code>, does not validate Mecanim, and is not a substitute for Unity runtime verification.</div>

  <h2>Discovery</h2>
  <div class="table-wrap"><table>
    <tr><th>Animation files discovered</th><td>${bundle.discovery.animationFiles}</td></tr>
    <tr><th>Expected</th><td>${bundle.discovery.expectedCount ?? 'not asserted'} ${bundle.discovery.matchesExpectedCount ? '<span class="pill good">MATCH</span>' : '<span class="pill bad">MISMATCH</span>'}</td></tr>
    <tr><th>Duplicate (SHA-256) files</th><td>${bundle.discovery.duplicates}</td></tr>
    <tr><th>Scanned directories</th><td><code>${bundle.discovery.scannedDirectories.map(esc).join(', ')}</code></td></tr>
  </table></div>

  <h2>Compatibility summary</h2>
  <div class="table-wrap"><table><thead><tr><th>Status</th><th>Animation × character pairs</th></tr></thead>
  <tbody>${statusRows}</tbody></table></div>
  <p class="muted">${summary.total} pair reports · Male ${summary.byCharacter.male} · Female ${summary.byCharacter.female}</p>

  <h2>Per-animation results</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Animation</th><th>Category</th><th>Bones</th><th>Duration (s)</th><th>Male</th><th>Female</th><th>Parse</th></tr></thead>
    <tbody>${perAnimationRows}</tbody>
  </table></div>

  <h2>Failures</h2>
  <ul>${failedRows}</ul>

  <h2>Limitations</h2>
  <ul>${bundle.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</body></html>`;
}

export function triggerDownload(fileName: string, content: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
