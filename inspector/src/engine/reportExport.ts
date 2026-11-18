import type { CharacterInspectionReport, FinalClassification } from './types';

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function classificationTone(cls: FinalClassification): {
  bg: string;
  fg: string;
  border: string;
} {
  switch (cls) {
    case 'RIGGED_AND_SKINNED':
      return { bg: '#064e3b', fg: '#6ee7b7', border: '#059669' };
    case 'SKELETON_PRESENT_BUT_NOT_SKINNED':
    case 'SKELETON_PRESENT_WITH_WEIGHT_ISSUES':
      return { bg: '#451a03', fg: '#fcd34d', border: '#d97706' };
    case 'SKELETON_MISSING':
    case 'INVALID_OR_INCOMPLETE_GLTF':
      return { bg: '#4c0519', fg: '#fda4af', border: '#e11d48' };
  }
}

export function serializeReportJson(report: CharacterInspectionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function generateReadableHtmlReport(report: CharacterInspectionReport): string {
  const tone = classificationTone(report.finalClassification);

  const statusRows: Array<[string, string, 'good' | 'warn' | 'bad']> = [
    ['Skeleton', report.statuses.skeleton, report.statuses.skeleton === 'Present' ? 'good' : 'bad'],
    [
      'Skinned Mesh',
      report.statuses.skinnedMesh,
      report.statuses.skinnedMesh === 'Present' ? 'good' : 'bad',
    ],
    [
      'Bone Weights',
      report.statuses.boneWeights,
      report.statuses.boneWeights === 'Valid'
        ? 'good'
        : report.statuses.boneWeights === 'Invalid'
          ? 'bad'
          : 'warn',
    ],
    [
      'Bone Hierarchy',
      report.statuses.boneHierarchy,
      report.statuses.boneHierarchy === 'Valid' ? 'good' : 'warn',
    ],
    [
      'Bind Pose',
      report.statuses.bindPose,
      report.statuses.bindPose === 'Available'
        ? 'good'
        : report.statuses.bindPose === 'Invalid'
          ? 'bad'
          : 'warn',
    ],
    [
      'Humanoid Structure (Heuristic)',
      report.statuses.humanoidStructure,
      report.statuses.humanoidStructure === 'Likely'
        ? 'good'
        : report.statuses.humanoidStructure === 'Incomplete'
          ? 'warn'
          : 'bad',
    ],
    [
      'Textures',
      report.statuses.textures,
      report.statuses.textures === 'Loaded' ? 'good' : 'bad',
    ],
  ];

  const humanoidRowsHtml = report.humanoid.slots
    .map((slot) => {
      const cls =
        slot.status === 'Found'
          ? 'pill-good'
          : slot.status === 'Possible match'
            ? 'pill-warn'
            : 'pill-bad';
      return `<tr>
        <td><strong>${escapeHtml(slot.label)}</strong></td>
        <td>${escapeHtml(slot.group)}</td>
        <td><span class="pill ${cls}">${escapeHtml(slot.status)}</span></td>
        <td><code>${escapeHtml(slot.matchedBoneName ?? '—')}</code></td>
        <td>${escapeHtml(slot.reason)}</td>
      </tr>`;
    })
    .join('\n');

  const skeletonSectionsHtml =
    report.skeletons.length === 0
      ? '<p class="muted">No skeletons detected in this GLTF document.</p>'
      : report.skeletons
          .map((sk) => {
            const boneRows = sk.bones
              .map(
                (b) => `<tr>
                <td>${b.jointIndex}</td>
                <td style="padding-left:${12 + Math.min(b.depth, 12) * 14}px"><code>${escapeHtml(b.displayName)}</code>${b.isRoot ? ' <span class="pill pill-info">ROOT</span>' : ''}${b.isDuplicateName ? ' <span class="pill pill-bad">DUPLICATE</span>' : ''}${b.isUnusualName ? ' <span class="pill pill-warn">LEAF / HELPER</span>' : ''}</td>
                <td>${b.depth}</td>
                <td><code>${escapeHtml(b.parentName ?? '—')}</code></td>
                <td><code>[${b.restTranslation.map((n) => n.toFixed(3)).join(', ')}]</code></td>
                <td>${b.inverseBindInvertible === null ? '—' : b.inverseBindInvertible ? 'Invertible' : 'Invalid'}</td>
              </tr>`,
              )
              .join('\n');

            return `<div class="card">
              <h3>Skeleton: ${escapeHtml(sk.name)} (${sk.totalBoneCount} bones, max depth ${sk.maxDepth})</h3>
              <p class="muted">Root bone(s): <code>${escapeHtml(sk.rootBoneNames.join(', ') || 'None')}</code> · THREE.Skeleton instantiated: <strong>${sk.threeSkeletonDetected ? 'Yes' : 'No'}</strong> · Connected SkinnedMeshes: <strong>${sk.connectedSkinnedMeshNames.length}</strong></p>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Joint #</th>
                      <th>Bone Name &amp; Hierarchy</th>
                      <th>Depth</th>
                      <th>Parent Bone</th>
                      <th>Rest Translation</th>
                      <th>IBM</th>
                    </tr>
                  </thead>
                  <tbody>${boneRows}</tbody>
                </table>
              </div>
            </div>`;
          })
          .join('\n');

  const skinningRowsHtml =
    report.skinning.primitives.length === 0
      ? '<p class="muted">No mesh primitives present.</p>'
      : `<div class="table-wrap"><table>
          <thead>
            <tr>
              <th>Mesh / Node</th>
              <th>Vertices</th>
              <th>Skinned</th>
              <th>Weight Sum Range</th>
              <th>Unnormalized</th>
              <th>Zero Weight</th>
              <th>Out-of-Range Idx</th>
              <th>Negative</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${report.skinning.primitives
              .map(
                (p) => `<tr>
                  <td><strong>${escapeHtml(p.meshName)}</strong> <span class="muted">(${escapeHtml(p.nodeName)})</span></td>
                  <td>${p.vertexCount.toLocaleString()}</td>
                  <td>${p.threeConnectedToSkeleton ? 'Yes' : 'No'}</td>
                  <td><code>${p.minWeightSum !== null && p.maxWeightSum !== null ? `${p.minWeightSum.toFixed(4)} .. ${p.maxWeightSum.toFixed(4)}` : '—'}</code></td>
                  <td>${p.unnormalizedVertexCount}</td>
                  <td>${p.zeroInfluenceVertexCount}</td>
                  <td>${p.outOfRangeIndexVertexCount}</td>
                  <td>${p.negativeWeightVertexCount}</td>
                  <td><span class="pill ${p.status === 'valid' ? 'pill-good' : p.status === 'not_skinned' ? 'pill-warn' : 'pill-bad'}">${escapeHtml(p.status.toUpperCase())}</span></td>
                </tr>`,
              )
              .join('\n')}
          </tbody>
        </table></div>`;

  const textureRowsHtml =
    report.textures.length === 0
      ? '<p class="muted">No image textures referenced by GLTF.</p>'
      : `<div class="table-wrap"><table>
          <thead>
            <tr>
              <th>#</th>
              <th>Image Name</th>
              <th>GLTF URI</th>
              <th>Resolved File</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${report.textures
              .map(
                (t) => `<tr>
                  <td>${t.imageIndex}</td>
                  <td>${escapeHtml(t.name)}</td>
                  <td><code>${escapeHtml(t.uri ?? '(bufferView)')}</code></td>
                  <td><code>${escapeHtml(t.resolvedFileName ?? '—')}</code></td>
                  <td><span class="pill ${t.status === 'loaded' ? 'pill-good' : 'pill-bad'}">${escapeHtml(t.status.toUpperCase())}</span></td>
                </tr>`,
              )
              .join('\n')}
          </tbody>
        </table></div>`;

  const materialBindingsHtml =
    report.materialTextureBindings.length === 0
      ? '<p class="muted">No material texture bindings found.</p>'
      : `<div class="table-wrap"><table>
          <thead>
            <tr>
              <th>Material</th>
              <th>Slot</th>
              <th>GLTF Image URI</th>
              <th>Resolved File</th>
              <th>Resolution</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${report.materialTextureBindings
              .map(
                (b) => `<tr>
                  <td><strong>${escapeHtml(b.materialName)}</strong></td>
                  <td><code>${escapeHtml(b.slot)}</code></td>
                  <td><code>${escapeHtml(b.imageUri ?? '—')}</code></td>
                  <td><code>${escapeHtml(b.resolvedFileName ?? '—')}</code></td>
                  <td><code>${escapeHtml(b.resolutionMode)}</code></td>
                  <td><span class="pill ${b.imageStatus === 'loaded' ? 'pill-good' : 'pill-bad'}">${escapeHtml(b.imageStatus.toUpperCase())}</span></td>
                </tr>`,
              )
              .join('\\n')}
          </tbody>
        </table></div>`;

  const issuesHtml =
    report.issues.length === 0
      ? '<p class="muted">No validation errors or warnings recorded.</p>'
      : `<ul>${report.issues
          .map(
            (i) =>
              `<li><span class="pill ${i.severity === 'error' ? 'pill-bad' : i.severity === 'warning' ? 'pill-warn' : 'pill-info'}">${escapeHtml(i.severity.toUpperCase())}</span> <strong>[${escapeHtml(i.code)}]</strong> ${escapeHtml(i.message)} <em>(${i.basis === 'confirmed_fact' ? 'Confirmed fact' : 'Heuristic finding'})</em></li>`,
          )
          .join('\n')}</ul>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(report.slotLabel)} — Skeleton Inspection Report</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 16px 48px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0b0f17;
      color: #e2e8f0;
      line-height: 1.55;
    }
    .container { max-width: 1080px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin: 0 0 6px; color: #f8fafc; }
    h2 { font-size: 1.125rem; margin: 28px 0 12px; color: #f1f5f9; border-bottom: 1px solid #1e293b; padding-bottom: 6px; }
    h3 { font-size: 1rem; margin: 0 0 8px; color: #f8fafc; }
    .meta { color: #94a3b8; font-size: 0.875rem; margin-bottom: 16px; }
    .classification-banner {
      display: inline-block;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-weight: 700;
      font-size: 1rem;
      background: ${tone.bg};
      color: ${tone.fg};
      border: 1px solid ${tone.border};
      margin-bottom: 16px;
    }
    .notice {
      background: #111827;
      border: 1px solid #334155;
      border-left: 4px solid #38bdf8;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 0.85rem;
      color: #cbd5e1;
      margin-bottom: 20px;
    }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .card {
      background: #111827;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1e293b; vertical-align: top; }
    th { color: #94a3b8; font-weight: 600; background: #0f172a; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; color: #7dd3fc; }
    .muted { color: #94a3b8; font-size: 0.85rem; }
    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .pill-good { background: #064e3b; color: #6ee7b7; }
    .pill-warn { background: #451a03; color: #fcd34d; }
    .pill-bad { background: #4c0519; color: #fda4af; }
    .pill-info { background: #0c4a6e; color: #7dd3fc; }
    ul { padding-left: 20px; margin: 8px 0; }
    li { margin-bottom: 6px; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(report.slotLabel)} — GLTF + BIN Skeleton Inspection Report</h1>
    <div class="meta">
      Primary GLTF: <code>${escapeHtml(report.primaryGltfFileName ?? 'None')}</code> ·
      Inspected: ${escapeHtml(report.inspectedAtIso)} ·
      ${escapeHtml(report.phase)}
    </div>

    <div class="classification-banner">
      Final Classification: ${escapeHtml(report.finalClassification)}
    </div>

    <div class="notice">
      <strong>Important Technical Scope:</strong>
      <ul>
        ${report.limitationsNotice.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}
      </ul>
    </div>

    <h2>Status Summary</h2>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Check</th><th>Status</th></tr></thead>
        <tbody>
          ${statusRows
            .map(
              ([label, val, kind]) =>
                `<tr><td><strong>${escapeHtml(label)}</strong></td><td><span class="pill pill-${kind}">${escapeHtml(val)}</span></td></tr>`,
            )
            .join('\n')}
        </tbody>
      </table>
    </div>

    <div class="grid-2">
      <div class="card">
        <h3>Confirmed Structural Facts</h3>
        <ul>
          ${
            report.confirmedFacts.length > 0
              ? report.confirmedFacts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')
              : '<li class="muted">None</li>'
          }
        </ul>
      </div>
      <div class="card">
        <h3>Heuristic Findings (Pattern-Based)</h3>
        <ul>
          ${
            report.heuristicFindings.length > 0
              ? report.heuristicFindings.map((f) => `<li>${escapeHtml(f)}</li>`).join('')
              : '<li class="muted">None</li>'
          }
        </ul>
      </div>
    </div>

    <h2>Validation Diagnostics</h2>
    <div class="card">${issuesHtml}</div>

    <h2>Material Texture Assignments</h2>
    <div class="card">${materialBindingsHtml}</div>

    <h2>External &amp; Embedded Textures</h2>
    <div class="card">${textureRowsHtml}</div>

    <h2>Skinning &amp; Vertex Weight Validation</h2>
    <div class="card">${skinningRowsHtml}</div>

    <h2>Humanoid Bone Structure Analysis (Heuristic — ${escapeHtml(report.humanoid.detectedNamingPattern)})</h2>
    <div class="card table-wrap">
      <p class="muted">${escapeHtml(report.humanoid.heuristicDisclaimer)}</p>
      <table>
        <thead>
          <tr>
            <th>Humanoid Slot</th>
            <th>Group</th>
            <th>Classification</th>
            <th>Matched Bone</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>${humanoidRowsHtml}</tbody>
      </table>
    </div>

    <h2>Skeleton &amp; Bone Hierarchy</h2>
    ${skeletonSectionsHtml}

    <h2>Uploaded Package Manifest</h2>
    <div class="card table-wrap">
      <p class="muted">${escapeHtml(report.licence.summaryNote)}</p>
      <table>
        <thead><tr><th>File Name</th><th>Role</th><th>Size (Bytes)</th></tr></thead>
        <tbody>
          ${report.uploadedFiles
            .map(
              (f) =>
                `<tr><td><code>${escapeHtml(f.name)}</code></td><td>${escapeHtml(f.role)}</td><td>${f.sizeBytes.toLocaleString()}</td></tr>`,
            )
            .join('\n')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
`;
}

export function triggerBrowserDownload(
  content: string,
  fileName: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1500);
}
