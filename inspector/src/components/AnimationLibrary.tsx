import { useMemo, useState } from 'react';
import type { AnimationAssetEntry, CompatibilityReport } from '../engine/animationTypes';

interface Props {
  assets: AnimationAssetEntry[];
  compatibility: CompatibilityReport[];
  characterSlot: 'male' | 'female';
  selectedId: string | null;
  processing: Set<string>;
  failed: Set<string>;
  onSelect: (asset: AnimationAssetEntry) => void;
}

const STATUS_FILTERS = ['All', 'Compatible', 'With warnings', 'Partial', 'Incompatible', 'Failed'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function statusBucket(report: CompatibilityReport | undefined): StatusFilter {
  if (!report) return 'All';
  switch (report.status) {
    case 'COMPATIBLE': return 'Compatible';
    case 'COMPATIBLE_WITH_WARNINGS': return 'With warnings';
    case 'PARTIALLY_COMPATIBLE': return 'Partial';
    case 'INCOMPATIBLE': return 'Incompatible';
    default: return 'Failed';
  }
}

const pillFor = (report?: CompatibilityReport): { cls: string; label: string } => {
  if (!report) return { cls: 'pill-info', label: 'not analysed' };
  switch (report.status) {
    case 'COMPATIBLE': return { cls: 'pill-good', label: 'compatible' };
    case 'COMPATIBLE_WITH_WARNINGS': return { cls: 'pill-warn', label: 'warnings' };
    case 'PARTIALLY_COMPATIBLE': return { cls: 'pill-warn', label: 'partial' };
    case 'INCOMPATIBLE': return { cls: 'pill-bad', label: 'incompatible' };
    default: return { cls: 'pill-bad', label: 'failed' };
  }
};

export default function AnimationLibrary({
  assets,
  compatibility,
  characterSlot,
  selectedId,
  processing,
  failed,
  onSelect,
}: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');
  const [status, setStatus] = useState<StatusFilter>('All');

  const reportFor = (assetId: string) =>
    compatibility.find((c) => c.assetId === assetId && c.characterSlot === characterSlot);

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(assets.map((a) => a.category))).sort()],
    [assets],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((a) => {
      if (q && !a.fileName.toLowerCase().includes(q)) return false;
      if (category !== 'All' && a.category !== category) return false;
      if (status !== 'All' && statusBucket(reportFor(a.id)) !== status) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, query, category, status, compatibility, characterSlot]);

  const analysedCount = assets.filter((a) => reportFor(a.id)).length;

  return (
    <section className="card library" aria-label="Animation library">
      <header className="card-head">
        <h3>🎞️ Animation library</h3>
        <span className="muted small">{assets.length} assets · {analysedCount} analysed</span>
      </header>

      <input
        type="search"
        className="search"
        placeholder="Search animations…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search animations"
      />

      <div className="filter-row">
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Filter by compatibility">
          {STATUS_FILTERS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <ul className="anim-list">
        {visible.length === 0 && <li className="muted small">No animations match the current filters.</li>}
        {visible.map((asset) => {
          const report = reportFor(asset.id);
          const pill = pillFor(report);
          const isProcessing = processing.has(asset.id);
          const isFailed = failed.has(asset.id);
          return (
            <li key={asset.id}>
              <button
                type="button"
                className={`anim-item ${selectedId === asset.id ? 'anim-item-active' : ''}`}
                onClick={() => onSelect(asset)}
                aria-pressed={selectedId === asset.id}
              >
                <span className="anim-name">{asset.fileName.replace(/\.fbx$/i, '')}</span>
                <span className="anim-meta">
                  <span className="chip small">{asset.category}</span>
                  <span className={`pill ${isFailed ? 'pill-bad' : pill.cls}`}>
                    {isProcessing ? 'parsing…' : isFailed ? 'failed' : pill.label}
                  </span>
                  <span className="muted small">{(asset.sizeBytes / 1024).toFixed(0)} KB</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
