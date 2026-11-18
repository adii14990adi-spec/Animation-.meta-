import { useState } from 'react';
import type { BoneHierarchyTreeNode, CharacterInspectionReport } from '../engine/types';
import { generateReadableHtmlReport, serializeReportJson, triggerBrowserDownload } from '../engine/reportExport';

interface Props {
  report: CharacterInspectionReport;
  onSelectBone: (name: string | null) => void;
}

function pillClass(value: string): string {
  const good = ['Present', 'Valid', 'Available', 'Likely', 'Loaded', 'Found'];
  const warn = ['Issues Found', 'Missing', 'Incomplete', 'Possible match', 'Ambiguous'];
  if (good.includes(value)) return 'pill pill-good';
  if (warn.includes(value)) return 'pill pill-warn';
  return 'pill pill-bad';
}

function TreeNode({ node, onSelectBone }: { node: BoneHierarchyTreeNode; onSelectBone: (n: string) => void }) {
  const [open, setOpen] = useState(node.depth < 2);
  return (
    <li>
      <span className="tree-row">
        {node.children.length > 0 && (
          <button type="button" className="tree-toggle" onClick={() => setOpen(!open)} aria-label="Toggle bone children">{open ? '▾' : '▸'}</button>
        )}
        <button type="button" className="tree-name" onClick={() => onSelectBone(node.name)}>
          <code>{node.name}</code>
        </button>
        {node.isRoot && <span className="pill pill-info">ROOT</span>}
        {node.isDuplicate && <span className="pill pill-bad">DUPLICATE</span>}
        {node.isUnusual && <span className="pill pill-warn">LEAF/HELPER</span>}
        <span className="muted"> #{node.jointIndex} · depth {node.depth}</span>
      </span>
      {open && node.children.length > 0 && (
        <ul className="tree-children">
          {node.children.map((c) => <TreeNode key={c.jointIndex} node={c} onSelectBone={onSelectBone} />)}
        </ul>
      )}
    </li>
  );
}

export default function ReportPanel({ report, onSelectBone }: Props) {
  const [showAllBones, setShowAllBones] = useState(false);
  const statuses: Array<[string, string]> = [
    ['Skeleton', report.statuses.skeleton],
    ['Skinned Mesh', report.statuses.skinnedMesh],
    ['Bone Weights', report.statuses.boneWeights],
    ['Bone Hierarchy', report.statuses.boneHierarchy],
    ['Bind Pose', report.statuses.bindPose],
    ['Humanoid Structure', report.statuses.humanoidStructure],
    ['Textures', report.statuses.textures],
  ];

  const downloadJson = () => {
    triggerBrowserDownload(serializeReportJson(report), `${report.slot}-inspection-report.json`, 'application/json');
  };
  const downloadHtml = () => {
    triggerBrowserDownload(generateReadableHtmlReport(report), `${report.slot}-inspection-report.html`, 'text/html');
  };

  return (
    <div className="report">
      <div className="report-head">
        <div>
          <h3>Inspection Report</h3>
          <p className="muted">
            {report.primaryGltfFileName ?? 'No GLTF'} · {report.gltfAssetMetadata.generator ?? 'Unknown generator'} · glTF {report.gltfAssetMetadata.version ?? '?'} · {new Date(report.inspectedAtIso).toLocaleString()}
          </p>
        </div>
        <div className="report-actions">
          <button type="button" className="btn btn-sm" onClick={downloadJson}>⬇ JSON</button>
          <button type="button" className="btn btn-sm" onClick={downloadHtml}>⬇ HTML</button>
        </div>
      </div>

      <div className={`classification classification-${report.finalClassification}`}>
        Final classification: <code>{report.finalClassification}</code>
      </div>

      <div className="status-grid">
        {statuses.map(([label, value]) => (
          <div className="status-item" key={label}>
            <span className="status-label">{label}</span>
            <span className={pillClass(value)}>{value}</span>
          </div>
        ))}
      </div>

      <div className="facts-grid">
        <section className="card">
          <h4>✅ Confirmed facts</h4>
          <ul>{report.confirmedFacts.length ? report.confirmedFacts.map((f, i) => <li key={i}>{f}</li>) : <li className="muted">None</li>}</ul>
        </section>
        <section className="card">
          <h4>🔍 Heuristic findings</h4>
          <ul>{report.heuristicFindings.length ? report.heuristicFindings.map((f, i) => <li key={i}>{f}</li>) : <li className="muted">None</li>}</ul>
        </section>
      </div>

      <section className="card">
        <h4>⚠️ Diagnostics ({report.issues.length})</h4>
        {report.issues.length === 0 ? <p className="muted">No validation errors or warnings.</p> : (
          <ul className="issues">
            {report.issues.map((issue, i) => (
              <li key={i}>
                <span className={`pill ${issue.severity === 'error' ? 'pill-bad' : issue.severity === 'warning' ? 'pill-warn' : 'pill-info'}`}>{issue.severity.toUpperCase()}</span>{' '}
                <strong>[{issue.code}]</strong> {issue.message}{' '}
                <em className="muted">({issue.basis === 'confirmed_fact' ? 'Confirmed fact' : 'Heuristic'})</em>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h4>🦴 Humanoid map — {report.humanoid.detectedNamingPattern} ({report.humanoid.foundCount} Found · {report.humanoid.possibleMatchCount} Possible · {report.humanoid.ambiguousCount} Ambiguous · {report.humanoid.missingCount} Missing)</h4>
        <p className="muted">{report.humanoid.heuristicDisclaimer}</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Slot</th><th>Group</th><th>Status</th><th>Matched bone</th></tr></thead>
            <tbody>
              {report.humanoid.slots.map((s) => (
                <tr key={s.key}>
                  <td><strong>{s.label}</strong></td>
                  <td>{s.group}</td>
                  <td><span className={pillClass(s.status)}>{s.status}</span></td>
                  <td>{s.matchedBoneName ? <button type="button" className="linklike" onClick={() => onSelectBone(s.matchedBoneName!)}><code>{s.matchedBoneName}</code></button> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h4>🧮 Skinning &amp; weights</h4>
        <p className="muted">
          Skinned vertices inspected: {report.skinning.totalSkinnedVerticesInspected.toLocaleString()} ·
          Unnormalized: {report.skinning.unnormalizedVertices} · Zero-influence: {report.skinning.zeroInfluenceVertices} ·
          Out-of-range joints: {report.skinning.outOfRangeJointVertices} · Negative weights: {report.skinning.negativeWeightVertices}
          {report.skinning.requiresWeightNormalization && ' · ⚠️ Normalization required (file left unmodified)'}
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Mesh</th><th>Verts</th><th>Weight sum</th><th>Unnorm.</th><th>Zero</th><th>Out-of-range</th><th>Status</th></tr></thead>
            <tbody>
              {report.skinning.primitives.map((p, i) => (
                <tr key={i}>
                  <td><strong>{p.meshName}</strong> <span className="muted">({p.nodeName})</span></td>
                  <td>{p.vertexCount.toLocaleString()}</td>
                  <td><code>{p.minWeightSum !== null && p.maxWeightSum !== null ? `${p.minWeightSum.toFixed(3)}..${p.maxWeightSum.toFixed(3)}` : '—'}</code></td>
                  <td>{p.unnormalizedVertexCount}</td>
                  <td>{p.zeroInfluenceVertexCount}</td>
                  <td>{p.outOfRangeIndexVertexCount}</td>
                  <td><span className={`pill ${p.status === 'valid' ? 'pill-good' : p.status === 'not_skinned' ? 'pill-warn' : 'pill-bad'}`}>{p.status.toUpperCase()}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h4>🎯 Bind pose</h4>
        <p className="muted">
          Status: <strong>{report.bindPose.status}</strong> · IBMs checked: {report.bindPose.totalMatricesChecked} ·
          Singular: {report.bindPose.singularNonInvertibleMatrixCount} · Naming: {report.bindPose.detectedNamingConvention}
          {report.bindPose.estimatedRigHeight !== null && ` · Est. rig height: ${report.bindPose.estimatedRigHeight}`}
        </p>
        {report.bindPose.notes.map((n, i) => <p key={i} className="muted">• {n}</p>)}
      </section>

      {report.skeletons.map((sk) => (
        <section className="card" key={sk.id}>
          <h4>🦴 Skeleton: {sk.name} — {sk.totalBoneCount} bones, max depth {sk.maxDepth}</h4>
          <p className="muted">
            Root(s): <code>{sk.rootBoneNames.join(', ') || 'None'}</code> · THREE.Skeleton: {sk.threeSkeletonDetected ? 'Yes' : 'No'} ·
            Connected SkinnedMeshes: {sk.connectedSkinnedMeshNames.join(', ') || 'None'}
            {sk.duplicateBoneNames.length > 0 && <> · Duplicates: <code>{sk.duplicateBoneNames.join(', ')}</code></>}
          </p>
          <h5>Bone hierarchy (tap a bone to highlight in 3D)</h5>
          <ul className="tree">
            {sk.hierarchyTree.map((n) => <TreeNode key={n.jointIndex} node={n} onSelectBone={onSelectBone} />)}
          </ul>
          <button type="button" className="btn btn-sm" onClick={() => setShowAllBones(!showAllBones)}>
            {showAllBones ? 'Hide bone table' : `Show all ${sk.bones.length} bones (table)`}
          </button>
          {showAllBones && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Bone</th><th>Depth</th><th>Parent</th><th>Rest T</th><th>IBM</th></tr></thead>
                <tbody>
                  {sk.bones.map((b) => (
                    <tr key={b.jointIndex}>
                      <td>{b.jointIndex}</td>
                      <td><button type="button" className="linklike" onClick={() => onSelectBone(b.displayName)}><code>{b.displayName}</code></button>{b.isRoot ? ' ROOT' : ''}{b.isDuplicateName ? ' DUP' : ''}</td>
                      <td>{b.depth}</td>
                      <td><code>{b.parentName ?? '—'}</code></td>
                      <td><code>[{b.restTranslation.map((n) => n.toFixed(2)).join(', ')}]</code></td>
                      <td>{b.inverseBindInvertible === null ? '—' : b.inverseBindInvertible ? '✓' : '✗'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <section className="card">
        <h4>🖼️ Textures &amp; buffers</h4>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Image</th><th>URI</th><th>Resolved</th><th>Status</th></tr></thead>
            <tbody>
              {report.textures.length === 0 ? <tr><td colSpan={5} className="muted">No textures referenced.</td></tr> :
                report.textures.map((t) => (
                  <tr key={t.imageIndex}>
                    <td>{t.imageIndex}</td><td><code>{t.name}</code></td><td><code>{t.uri ?? '(bufferView)'}</code></td>
                    <td><code>{t.resolvedFileName ?? '—'}</code></td>
                    <td><span className={`pill ${t.status === 'loaded' ? 'pill-good' : 'pill-bad'}`}>{t.status.toUpperCase()}</span></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Buffer</th><th>URI</th><th>Declared</th><th>Actual</th><th>Status</th></tr></thead>
            <tbody>
              {report.buffers.map((b) => (
                <tr key={b.bufferIndex}>
                  <td>{b.bufferIndex}</td><td><code>{b.uri ?? '(embedded)'}</code></td>
                  <td>{b.declaredByteLength.toLocaleString()}</td><td>{b.actualByteLength?.toLocaleString() ?? '—'}</td>
                  <td><span className={`pill ${b.status === 'valid' ? 'pill-good' : 'pill-bad'}`}>{b.status.toUpperCase()}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h4>📦 Uploaded package manifest</h4>
        <p className="muted">{report.licence.summaryNote}</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>File</th><th>Role</th><th>Size</th></tr></thead>
            <tbody>
              {report.uploadedFiles.map((f, i) => (
                <tr key={i}><td><code>{f.name}</code></td><td>{f.role}</td><td>{f.sizeBytes.toLocaleString()} B</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
