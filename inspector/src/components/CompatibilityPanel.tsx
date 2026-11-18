import { useMemo, useState } from 'react';
import type {
  BoneMappingEntry,
  CompatibilityReport,
  HumanoidSlotId,
  NormalizedSkeleton,
} from '../engine/animationTypes';
import { SLOT_DEFINITIONS } from '../engine/humanoidRegistry';

interface Props {
  report: CompatibilityReport | null;
  mapping: BoneMappingEntry[];
  animationBoneNames: string[];
  characterBoneNames: string[];
  onOverride: (slot: HumanoidSlotId, animationBone: string | null) => void;
  onResetOverrides: () => void;
  hasOverrides: boolean;
}

const statusClass = (status: string): string => {
  if (status === 'COMPATIBLE') return 'pill-good';
  if (status === 'COMPATIBLE_WITH_WARNINGS' || status === 'PARTIALLY_COMPATIBLE') return 'pill-warn';
  return 'pill-bad';
};

export default function CompatibilityPanel({
  report,
  mapping,
  animationBoneNames,
  characterBoneNames,
  onOverride,
  onResetOverrides,
  hasOverrides,
}: Props) {
  const [showAll, setShowAll] = useState(false);
  const [editingSlot, setEditingSlot] = useState<HumanoidSlotId | null>(null);

  const rows = useMemo(
    () => (showAll ? mapping : mapping.filter((m) => SLOT_DEFINITIONS[m.slot].required || m.animationBone)),
    [mapping, showAll],
  );

  if (!report) {
    return (
      <section className="card">
        <h3>🔗 Compatibility</h3>
        <p className="muted">Run the analysis to see per-animation compatibility for the selected character.</p>
      </section>
    );
  }

  const mappedCount = mapping.filter((m) => m.animationBone && m.characterBone).length;

  return (
    <section className="card" aria-label="Compatibility panel">
      <header className="card-head">
        <h3>🔗 Compatibility — {report.characterSlot === 'male' ? 'Male' : 'Female'}</h3>
        <span className={`pill ${statusClass(report.status)}`}>{report.status.replace(/_/g, ' ')}</span>
      </header>

      <p className="muted small">
        Source <code>{report.fileName}</code> · retarget readiness{' '}
        <strong>{report.retargetReadiness.replace(/_/g, ' ')}</strong>
      </p>

      <div className="stat-grid">
        <div><span>{report.scoring.requiredSlotsMapped}/{report.scoring.requiredSlotsTotal}</span><small>required slots</small></div>
        <div><span>{(report.scoring.requiredSlotCoverage * 100).toFixed(0)}%</span><small>coverage</small></div>
        <div><span>{report.hierarchy.validParents}/{report.hierarchy.checkedParents}</span><small>hierarchy valid</small></div>
        <div>
          <span>
            {report.trackAnalysis.matchedTracks}/
            {report.trackAnalysis.matchedTracks + report.trackAnalysis.unmatchedTracks}
          </span>
          <small>matched bones</small>
        </div>
        <div><span>{(report.scoring.meanMappingConfidence * 100).toFixed(0)}%</span><small>mapping confidence</small></div>
        <div><span>{report.restPose.maxRestRotationDeltaDeg?.toFixed(1) ?? '—'}°</span><small>max rest Δ</small></div>
      </div>

      <details className="trace">
        <summary>Why this verdict? (rule trace)</summary>
        <ul>{report.scoring.ruleTrace.map((r, i) => <li key={i}><code>{r}</code></li>)}</ul>
      </details>

      {report.requiredBonesMissing.length > 0 && (
        <p className="warn-line">Missing required slots: {report.requiredBonesMissing.join(', ')}</p>
      )}

      <h4>Bone mapping ({mappedCount}/{mapping.length} mapped)</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Slot</th><th>Animation bone</th><th>Character bone</th><th>Method</th><th>Hierarchy</th><th>Conf.</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.slot} className={!m.animationBone ? 'row-missing' : undefined}>
                <td><strong>{SLOT_DEFINITIONS[m.slot].label}</strong></td>
                <td>
                  {editingSlot === m.slot ? (
                    <select
                      value={m.animationBone ?? ''}
                      onChange={(e) => {
                        onOverride(m.slot, e.target.value || null);
                        setEditingSlot(null);
                      }}
                      aria-label={`Animation bone for ${m.slot}`}
                    >
                      <option value="">— unmapped —</option>
                      {animationBoneNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ) : (
                    <code>{m.animationBone ?? '—'}</code>
                  )}
                </td>
                <td>
                  <code className={characterBoneNames.includes(m.characterBone ?? '') ? '' : 'text-bad'}>
                    {m.characterBone ?? '—'}
                  </code>
                </td>
                <td><span className="chip small">{m.method}</span></td>
                <td>{m.hierarchyValid === null ? '—' : m.hierarchyValid ? '✅' : '⚠️'}</td>
                <td>{(m.confidence * 100).toFixed(0)}%</td>
                <td>
                  <button type="button" className="link-btn" onClick={() => setEditingSlot(editingSlot === m.slot ? null : m.slot)}>
                    {editingSlot === m.slot ? 'cancel' : 'edit'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row-actions">
        <button type="button" className="btn small" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show required only' : 'Show all 32 slots'}
        </button>
        {hasOverrides && (
          <button type="button" className="btn small" onClick={onResetOverrides}>
            Reset manual mappings
          </button>
        )}
      </div>

      {report.issues.length > 0 && (
        <>
          <h4>Warnings &amp; validation output ({report.issues.length})</h4>
          <ul className="issue-list">
            {report.issues.map((issue, i) => (
              <li key={i} className={`issue ${issue.severity}`}>
                <span className={`pill ${issue.severity === 'error' ? 'pill-bad' : issue.severity === 'warning' ? 'pill-warn' : 'pill-info'}`}>
                  {issue.severity.toUpperCase()}
                </span>{' '}
                <strong>[{issue.code}]</strong> {issue.message}
              </li>
            ))}
          </ul>
        </>
      )}

      <details className="trace">
        <summary>Track analysis detail</summary>
        <p className="muted small">
          {report.trackAnalysis.matchedTracks} of{' '}
          {report.trackAnalysis.matchedTracks + report.trackAnalysis.unmatchedTracks} slot-level animated bones matched
          to a mapped bone. {report.trackAnalysis.extraDetailTracks} extra detail bone(s) (finger phalanges 2–4, *_leaf
          tips) are outside the 32 humanoid slots and are not retargeted.
        </p>
        {report.trackAnalysis.unmatchedTracks_detail.length > 0 && (
          <ul>
            {report.trackAnalysis.unmatchedTracks_detail.map((t, i) => <li key={i}><code>{t}</code></li>)}
          </ul>
        )}
      </details>

      <details className="trace">
        <summary>Rest-pose &amp; hierarchy detail</summary>
        <ul>
          <li>Max rest rotation delta: {report.restPose.maxRestRotationDeltaDeg ?? '—'}°</li>
          <li>Max limb-length deviation: {((report.restPose.maxLimbLengthDeviationRatio ?? 0) * 100).toFixed(1)}%</li>
          <li>Side validation: {report.sideValidation.checked} checked, {report.sideValidation.violations.length} issue(s)</li>
          {report.restPose.notes.map((n, i) => <li key={i}>{n}</li>)}
          {report.hierarchy.mismatches.map((m, i) => (
            <li key={i}><code>{m.slot}</code> parent is <code>{m.animationParent ?? '(none)'}</code>, expected <code>{m.expectedParentSlot}</code></li>
          ))}
        </ul>
      </details>

      <p className="muted small">
        Browser-side analysis only — not Unity AvatarBuilder and not a guarantee of Unity Humanoid compatibility.
      </p>
    </section>
  );
}

/** Slot ordering helper used by tests. */
export function requiredSlotIds(skeleton: NormalizedSkeleton): HumanoidSlotId[] {
  void skeleton;
  return (Object.keys(SLOT_DEFINITIONS) as HumanoidSlotId[]).filter((s) => SLOT_DEFINITIONS[s].required);
}
