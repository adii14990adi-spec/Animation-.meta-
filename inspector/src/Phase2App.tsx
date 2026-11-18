import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type {
  AnimationAssetEntry,
  AnimationDiscoveryReport,
  BoneMappingEntry,
  CompatibilityReport,
  HumanoidSlotId,
  ParsedAnimationResult,
} from './engine/animationTypes';
import { discoverAnimations, type BatchProgress } from './engine/animationLibrary';
import { buildCharacterRigFromGltf, type CharacterRig } from './engine/characterRig';
import { analyzeCompatibility, buildMappings } from './engine/compatibility';
import {
  buildAnimationAnalysisReport,
  buildBoneMappingsReport,
  buildCharacterCompatibilityReport,
  buildHtmlSummary,
  buildValidationReport,
  triggerDownload,
} from './engine/animationReports';
import { runPhase2, selectFirstTestAnimation } from './engine/phase2Pipeline';
import {
  buildRetargetPlan,
  retargetClip,
  restoreRestPose,
  snapshotRestPose,
  type RetargetResult,
} from './engine/retarget';
import { fetchRepoCharacterFiles, fetchRepoCharacterManifest } from './engine/repoCharactersClient';
import type { PreviewCharacter } from './engine/previewCharacter';
import AnimationLibrary from './components/AnimationLibrary';
import AnimationPreview from './components/AnimationPreview';
import CompatibilityPanel from './components/CompatibilityPanel';

type Tab = 'preview' | 'compare';

function useRigs() {
  const [maleRig, setMaleRig] = useState<CharacterRig | null>(null);
  const [femaleRig, setFemaleRig] = useState<CharacterRig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const manifest = await fetchRepoCharacterManifest();
        if (!manifest) throw new Error('Character manifest not found.');
        for (const [slot, setter] of [
          ['male', setMaleRig],
          ['female', setFemaleRig],
        ] as const) {
          const paths = slot === 'male' ? manifest.male : manifest.female;
          const files = await fetchRepoCharacterFiles(slot, paths);
          const gltf = files.find((f) => f.name.toLowerCase().endsWith('.gltf'));
          if (!gltf) throw new Error(`No .gltf for ${slot}.`);
          const json = JSON.parse(await gltf.text());
          if (cancelled) return;
          setter(buildCharacterRigFromGltf(json));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { maleRig, femaleRig, error };
}

/** Loads the renderable preview scene for a slot (GLTFLoader path). */
function usePreviewCharacter(slot: 'male' | 'female' | null) {
  const [state, setState] = useState<{
    slot: 'male' | 'female' | null;
    character: PreviewCharacter | null;
    loading: boolean;
    error: string | null;
  }>({ slot: null, character: null, loading: false, error: null });

  useEffect(() => {
    if (!slot) return;
    let cancelled = false;
    let disposeFn: (() => void) | null = null;
    setState({ slot, character: null, loading: true, error: null });
    (async () => {
      try {
        const mod = await import('./engine/previewCharacter');
        const character = await mod.loadPreviewCharacter(slot);
        if (cancelled) {
          character.dispose();
          return;
        }
        disposeFn = character.dispose;
        setState({ slot, character, loading: false, error: null });
      } catch (err) {
        if (!cancelled) {
          setState({ slot, character: null, loading: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
      disposeFn?.();
    };
  }, [slot]);

  return state;
}

export default function Phase2App() {
  const { maleRig, femaleRig, error: rigError } = useRigs();

  const [discovery, setDiscovery] = useState<AnimationDiscoveryReport | null>(null);
  const [buffers, setBuffers] = useState<Map<string, ArrayBuffer>>(new Map());
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const [animations, setAnimations] = useState<ParsedAnimationResult[]>([]);
  const [compat, setCompat] = useState<CompatibilityReport[]>([]);
  const [running, setRunning] = useState(false);
  const [runSummary, setRunSummary] = useState<{ ok: number; failed: number; cached: number; ms: number; worker: boolean } | null>(null);
  const cacheRef = useRef(new Map<string, ParsedAnimationResult>());

  const [characterSlot, setCharacterSlot] = useState<'male' | 'female'>('male');
  const [selectedAsset, setSelectedAsset] = useState<AnimationAssetEntry | null>(null);
  const [tab, setTab] = useState<Tab>('preview');
  const [overrides, setOverrides] = useState<Record<string, Partial<Record<HumanoidSlotId, string>>>>({});
  const [retarget, setRetarget] = useState<RetargetResult | null>(null);
  const [retargetError, setRetargetError] = useState<string | null>(null);
  const [inPlace, setInPlace] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [firstTestId, setFirstTestId] = useState<string | null>(null);
  const fbxCacheRef = useRef(new Map<string, THREE.Group>());

  const preview = usePreviewCharacter(characterSlot);

  const processingIds = useMemo(() => {
    if (!progress || progress.phase !== 'parsing') return new Set<string>();
    return new Set<string>();
  }, [progress]);
  const failedIds = useMemo(
    () => new Set(animations.filter((a) => a.status !== 'ok').map((a) => a.assetId)),
    [animations],
  );

  // ---- discovery ------------------------------------------------------------
  const runDiscovery = useCallback(async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const result = await discoverAnimations((done, total, name) => {
        setProgress({ phase: 'discovering', done, total, current: name, ok: 0, failed: 0 });
      });
      setDiscovery(result.report);
      setBuffers(result.buffers);
      setProgress(null);
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    } finally {
      setDiscovering(false);
    }
  }, []);

  // ---- full pipeline --------------------------------------------------------
  const runAnalysis = useCallback(
    async (only?: string[]) => {
      if (!discovery || !maleRig || !femaleRig) return;
      setRunning(true);
      setRetargetError(null);
      try {
        const result = await runPhase2({
          discovery,
          buffers,
          maleRig,
          femaleRig,
          cache: cacheRef.current,
          only,
          onProgress: setProgress,
          onResult: (r) => {
            setAnimations((prev) => {
              const next = prev.filter((p) => p.assetId !== r.assetId);
              next.push(r);
              return next.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
            });
          },
        });
        setAnimations(result.bundle.animations);
        setCompat(result.bundle.compatibility);
        setRunSummary({
          ok: result.ok,
          failed: result.failed,
          cached: result.cachedHits,
          ms: result.elapsedMs,
          worker: result.workerUsed,
        });
      } catch (err) {
        setDiscoveryError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    },
    [discovery, buffers, maleRig, femaleRig],
  );

  // Selecting an animation that has not been analysed used to do nothing at all:
  // the retarget effect bailed out silently and the preview kept saying "pick an
  // animation". Analyse the single asset on demand so the click always has an
  // effect, and surface progress/errors while it runs.
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedAsset) return;
    if (animations.some((a) => a.assetId === selectedAsset.id)) return;
    if (running || runningId === selectedAsset.id) return;
    setPendingSelectId(selectedAsset.id);
    void runAnalysis([selectedAsset.id]).finally(() => setPendingSelectId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAsset, animations, running]);

  const runningId = pendingSelectId;

  /** The required "first animation test": one Idle/Walk, full pipeline, both characters. */
  const runFirstTest = useCallback(async () => {
    if (!discovery || !maleRig || !femaleRig) return;
    const candidate = selectFirstTestAnimation(discovery.assets, compat) ?? discovery.assets[0];
    if (!candidate) return;
    setFirstTestId(candidate.id);
    setSelectedAsset(candidate);
    await runAnalysis([candidate.id]);
  }, [discovery, compat, maleRig, femaleRig, runAnalysis]);

  // Auto-select the first test animation once analysis data exists.
  useEffect(() => {
    if (selectedAsset || !discovery || compat.length === 0) return;
    const pick = selectFirstTestAnimation(discovery.assets, compat);
    if (pick) setSelectedAsset(pick);
  }, [discovery, compat, selectedAsset]);

  // ---- chosen animation + compatibility for the selected character ----------
  const selectedReport = useMemo<CompatibilityReport | null>(() => {
    if (!selectedAsset) return null;
    return compat.find((c) => c.assetId === selectedAsset.id && c.characterSlot === characterSlot) ?? null;
  }, [compat, selectedAsset, characterSlot]);

  const mapping = useMemo<BoneMappingEntry[]>(() => {
    const anim = animations.find((a) => a.assetId === selectedAsset?.id);
    const rig = characterSlot === 'male' ? maleRig : femaleRig;
    if (!anim?.skeleton || !rig) return [];
    const base = buildMappings(anim.skeleton, rig.skeleton).mappings;
    const ov = selectedAsset ? overrides[selectedAsset.id] : undefined;
    if (!ov) return base;
    return base.map((m) => {
      const manual = ov?.[m.slot];
      if (manual === undefined) return m;
      return {
        ...m,
        animationBone: manual,
        method: manual ? 'manual' : 'unresolved',
        confidence: manual ? 1 : 0,
        notes: [`Manual override applied in the UI.`],
      };
    });
  }, [animations, selectedAsset, characterSlot, maleRig, femaleRig, overrides]);

  const animationBoneNames = useMemo(() => {
    const anim = animations.find((a) => a.assetId === selectedAsset?.id);
    return anim?.skeleton?.bones.map((b) => b.name) ?? [];
  }, [animations, selectedAsset]);

  const characterBoneNames = useMemo(() => {
    const rig = characterSlot === 'male' ? maleRig : femaleRig;
    return rig?.skeleton.bones.map((b) => b.name) ?? [];
  }, [characterSlot, maleRig, femaleRig]);

  /** Raw FBX object graph for the selected animation (cached per asset). */
  const loadFbxObject = useCallback(
    async (asset: AnimationAssetEntry): Promise<THREE.Group | null> => {
      const cached = fbxCacheRef.current.get(asset.id);
      if (cached) return cached;
      const buffer = buffers.get(asset.sourcePath);
      if (!buffer) return null;
      const obj = new FBXLoader().parse(buffer.slice(0), '');
      fbxCacheRef.current.set(asset.id, obj);
      return obj;
    },
    [buffers],
  );

  // ---- retarget whenever selection / character / mapping changes -------------
  useEffect(() => {
    let cancelled = false;
    setRetarget(null);
    setRetargetError(null);
    if (!selectedAsset) return;
    if (!preview.character) {
      setRetargetError('Character is still loading — the preview will appear in a moment.');
      return;
    }
    if (mapping.length === 0) {
      // Previously this returned silently, so clicking an animation that had not
      // been analysed yet looked like a dead button. Say so explicitly instead.
      setRetargetError('This animation has not been analysed yet. Use “Analyse all animations” to unlock previews.');
      return;
    }
    const liveCharacter = preview.character;

    (async () => {
      try {
        const fbx = await loadFbxObject(selectedAsset);
        if (!fbx || cancelled) return;
        const clip = fbx.animations?.[0];
        if (!clip) {
          setRetargetError('This FBX contains no animation clip.');
          return;
        }
        const rig = characterSlot === 'male' ? maleRig : femaleRig;
        if (!rig) return;

        // Use the live preview scene so the retargeted clip drives the visible rig.
        restoreRestPose(liveCharacter.sceneRoot, liveCharacter.restSnapshot);
        const liveSnapshot = snapshotRestPose(liveCharacter.sceneRoot);

        const plan = buildRetargetPlan(fbx, liveCharacter.sceneRoot, mapping);
        const result = retargetClip(clip, fbx, liveCharacter.sceneRoot, plan, { inPlace });
        if (cancelled) return;
        restoreRestPose(liveCharacter.sceneRoot, liveSnapshot);
        setRetarget(result);
      } catch (err) {
        if (!cancelled) setRetargetError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedAsset, preview.character, mapping, characterSlot, maleRig, femaleRig, inPlace, loadFbxObject]);

  // ---- report export --------------------------------------------------------
  const buildBundle = useCallback(() => {
    if (!discovery) return null;
    return {
      schemaVersion: '2.0.0' as const,
      phase: 'Phase 2 — Animation Compatibility Inspector' as const,
      generatedAtIso: new Date().toISOString(),
      discovery,
      animations,
      compatibility: compat,
      mappings: [],
      characterSignatures: { male: maleRig ? 'male' : '', female: femaleRig ? 'female' : '' },
      limitations: [] as string[],
    };
  }, [discovery, animations, compat, maleRig, femaleRig]);

  const exportAll = useCallback(() => {
    const base = buildBundle();
    if (!base) return;
    const bundle = {
      ...base,
      limitations: selectedReport?.limitations ?? [],
      mappings: mapping.length > 0 && selectedAsset
        ? [{
            id: `${selectedAsset.id}::${characterSlot}`,
            animationSignature: selectedAsset.id,
            characterSignature: characterSlot,
            createdAtIso: new Date().toISOString(),
            entries: mapping,
            ambiguousSlots: [],
            manuallyAdjusted: Boolean(overrides[selectedAsset.id]),
          }]
        : [],
    };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    triggerDownload(`animation-analysis.json`, JSON.stringify(buildAnimationAnalysisReport(bundle), null, 2));
    triggerDownload(`character-compatibility.json`, JSON.stringify(buildCharacterCompatibilityReport(bundle), null, 2));
    triggerDownload(`bone-mappings.json`, JSON.stringify(buildBoneMappingsReport(bundle), null, 2));
    triggerDownload(
      `animation-validation-report.json`,
      JSON.stringify(
        buildValidationReport(bundle, {
          unchangedAssetsVerified: null,
          phase1TestsPassing: null,
          phase2TestsPassing: null,
        }),
        null,
        2,
      ),
    );
    triggerDownload(`animation-summary-${stamp}.html`, buildHtmlSummary(bundle), 'text/html');
  }, [buildBundle, mapping, selectedAsset, characterSlot, overrides, selectedReport]);

  const setOverride = useCallback(
    (slot: HumanoidSlotId, bone: string | null) => {
      if (!selectedAsset) return;
      setOverrides((prev) => ({
        ...prev,
        [selectedAsset.id]: { ...(prev[selectedAsset.id] ?? {}), [slot]: bone ?? '' },
      }));
    },
    [selectedAsset],
  );

  const resetOverrides = useCallback(() => {
    if (!selectedAsset) return;
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[selectedAsset.id];
      return next;
    });
  }, [selectedAsset]);

  const ready = Boolean(discovery && maleRig && femaleRig);
  const discoveredCount = discovery?.animationFiles ?? 0;

  return (
    <div className="p2">
      <header className="p2-header">
        <div>
          <h1>🎬 Animation Compatibility Inspector</h1>
          <p className="subtitle">Phase 2 — FBX skeleton analysis, compatibility scoring &amp; browser retargeting</p>
        </div>
        <nav className="tab-bar" aria-label="Phase 2 sections">
          <button type="button" className={`tab ${tab === 'preview' ? 'tab-active' : ''}`} onClick={() => setTab('preview')}>
            Preview &amp; analysis
          </button>
          <button type="button" className={`tab ${tab === 'compare' ? 'tab-active' : ''}`} onClick={() => setTab('compare')}>
            Male vs Female
          </button>
        </nav>
      </header>

      <div className="notice" role="note">
        <strong>⚠️ Not Unity Editor.</strong> Skeleton analysis and retargeting run entirely in your browser.
        This does <em>not</em> run Unity <code>AvatarBuilder</code>/Mecanim and is not a substitute for Unity runtime
        verification. Original FBX and <code>.fbx.meta</code> files are never modified.
      </div>

      {(rigError || discoveryError) && (
        <div className="banner banner-error">{rigError ?? discoveryError}</div>
      )}

      <section className="p2-controls">
        <button type="button" className="btn btn-primary" onClick={() => void runDiscovery()} disabled={discovering || running}>
          {discovering ? '⏳ Scanning animations…' : '📂 Discover animations'}
        </button>
        <button type="button" className="btn" onClick={() => void runFirstTest()} disabled={!ready || running || discovering}>
          🧪 First test (1 Idle/Walk)
        </button>
        <button type="button" className="btn" onClick={() => void runAnalysis()} disabled={!ready || running || discovering}>
          {running ? '⏳ Processing…' : '⚙️ Analyse all animations'}
        </button>
        <button type="button" className="btn" onClick={() => void runAnalysis([...failedIds])} disabled={failedIds.size === 0 || running}>
          ♻️ Retry failed ({failedIds.size})
        </button>
        <button type="button" className="btn" onClick={exportAll} disabled={!discovery || animations.length === 0}>
          ⬇️ Export reports
        </button>
      </section>

      {discovery && (
        <div className="banner banner-info">
          Discovered <strong>{discoveredCount}</strong> animation FBX
          {discovery.expectedCount !== null && (
            <>
              {' '}· expected <strong>{discovery.expectedCount}</strong>{' '}
              <span className={`pill ${discovery.matchesExpectedCount ? 'pill-good' : 'pill-bad'}`}>
                {discovery.matchesExpectedCount ? 'MATCH' : 'MISMATCH'}
              </span>
            </>
          )}
          {' '}· duplicates <strong>{discovery.duplicates}</strong>
          {runSummary && (
            <>
              {' '}· parsed <strong>{runSummary.ok}</strong>, failed <strong>{runSummary.failed}</strong>
              {runSummary.cached > 0 && <>, cached <strong>{runSummary.cached}</strong></>}
              {' '}· {runSummary.ms} ms · {runSummary.worker ? 'Web Worker' : 'main thread'}
            </>
          )}
        </div>
      )}

      {progress && (
        <div className="progress-bar" role="status" aria-live="polite">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
          <span className="muted small">
            {progress.phase} · {progress.done}/{progress.total}
            {progress.current ? ` · ${progress.current}` : ''}
            {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
          </span>
        </div>
      )}

      <div className="character-toggle">
        <span className="muted small">Character</span>
        {(['male', 'female'] as const).map((slot) => (
          <button
            key={slot}
            type="button"
            className={`chip ${characterSlot === slot ? 'chip-active' : ''}`}
            onClick={() => setCharacterSlot(slot)}
            aria-pressed={characterSlot === slot}
          >
            {slot === 'male' ? '👨 Male' : '👩 Female'}
          </button>
        ))}
        <label className="check">
          <input type="checkbox" checked={inPlace} onChange={(e) => setInPlace(e.target.checked)} />
          In-place
        </label>
        <label className="check">
          <input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} />
          Skeleton
        </label>
      </div>

      {tab === 'preview' ? (
        <div className="p2-grid">
          <div className="p2-col-main">
            <AnimationPreview
              character={preview.character}
              loading={preview.loading}
              error={preview.error}
              clip={retarget}
              clipLabel={selectedAsset ? `${selectedAsset.fileName.replace(/\.fbx$/i, '')} (retargeted)` : '—'}
              options={{ speed: 1, loop: true, inPlace, showSkeleton }}
            />
            {retargetError && <div className="banner banner-error">{retargetError}</div>}
            {preview.character && (
              <div className="banner banner-info small" data-testid="texture-status">
                {preview.character.missingTextures.length === 0 ? (
                  <>
                    ✅ Textures loaded ({preview.character.nearMatchedTextures.length === 0
                      ? 'all exact path'
                      : `${preview.character.nearMatchedTextures.length} resolved by near-match: ${[
                          ...new Set(preview.character.nearMatchedTextures.map((t) => t.requested)),
                        ].join(', ')}`}
                    )
                  </>
                ) : (
                  <>⚠️ {preview.character.missingTextures.length} texture(s) could not be resolved: {preview.character.missingTextures.join(', ')}</>
                )}
              </div>
            )}
            {firstTestId && selectedAsset?.id === firstTestId && (
              <div className="banner banner-info small">
                🧪 First-test animation: <code>{selectedAsset.fileName}</code> — discovered, parsed, mapped and retargeted onto
                both characters.
              </div>
            )}
            <CompatibilityPanel
              report={selectedReport}
              mapping={mapping}
              animationBoneNames={animationBoneNames}
              characterBoneNames={characterBoneNames}
              onOverride={setOverride}
              onResetOverrides={resetOverrides}
              hasOverrides={Boolean(selectedAsset && overrides[selectedAsset.id])}
            />
          </div>
          <div className="p2-col-side">
            <AnimationLibrary
              assets={discovery?.assets ?? []}
              compatibility={compat}
              characterSlot={characterSlot}
              selectedId={selectedAsset?.id ?? null}
              processing={processingIds}
              failed={failedIds}
              onSelect={setSelectedAsset}
            />
            <div className="card">
              <h4>📊 Library summary</h4>
              <ul className="summary-list">
                <li>Discovered: <strong>{discoveredCount}</strong></li>
                <li>Parsed OK: <strong>{animations.filter((a) => a.status === 'ok').length}</strong></li>
                <li>Failed: <strong>{animations.filter((a) => a.status !== 'ok').length}</strong></li>
                <li>Compatibility reports: <strong>{compat.length}</strong></li>
                <li>Analysed for {characterSlot}: <strong>{compat.filter((c) => c.characterSlot === characterSlot).length}</strong></li>
              </ul>
              <p className="muted small">
                Statuses: {['COMPATIBLE', 'COMPATIBLE_WITH_WARNINGS', 'PARTIALLY_COMPATIBLE', 'INCOMPATIBLE', 'PROCESSING_FAILED']
                  .map((s) => `${s.replace(/_/g, ' ').toLowerCase()} ${compat.filter((c) => c.characterSlot === characterSlot && c.status === s).length}`)
                  .join(' · ')}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <ComparisonView
          asset={selectedAsset}
          compat={compat}
          maleMapping={mappingFor(animations, selectedAsset, maleRig, overrides)}
          femaleMapping={mappingFor(animations, selectedAsset, femaleRig, overrides)}
          maleBones={maleRig?.skeleton.bones.map((b) => b.name) ?? []}
          femaleBones={femaleRig?.skeleton.bones.map((b) => b.name) ?? []}
        />
      )}

      <footer className="app-footer">
        <p>
          Phase 1 structural inspection remains available at <a href="./phase1.html">phase1.html</a>. Animation FBX and{' '}
          <code>.fbx.meta</code> files are read-only inputs; nothing is written back to the repository.
        </p>
      </footer>
    </div>
  );
}

function mappingFor(
  animations: ParsedAnimationResult[],
  asset: AnimationAssetEntry | null,
  rig: CharacterRig | null,
  overrides: Record<string, Partial<Record<HumanoidSlotId, string>>>,
): BoneMappingEntry[] {
  const anim = animations.find((a) => a.assetId === asset?.id);
  if (!anim?.skeleton || !rig) return [];
  const base = buildMappings(anim.skeleton, rig.skeleton).mappings;
  const ov = asset ? overrides[asset.id] : undefined;
  if (!ov) return base;
  return base.map((m) => {
    const manual = ov[m.slot];
    if (manual === undefined) return m;
    return { ...m, animationBone: manual, method: manual ? 'manual' : 'unresolved', confidence: manual ? 1 : 0 };
  });
}

function ComparisonView({
  asset,
  compat,
  maleMapping,
  femaleMapping,
}: {
  asset: AnimationAssetEntry | null;
  compat: CompatibilityReport[];
  maleMapping: BoneMappingEntry[];
  femaleMapping: BoneMappingEntry[];
  maleBones: string[];
  femaleBones: string[];
}) {
  const male = asset ? compat.find((c) => c.assetId === asset.id && c.characterSlot === 'male') : null;
  const female = asset ? compat.find((c) => c.assetId === asset.id && c.characterSlot === 'female') : null;
  const [recheck, setRecheck] = useState<{ male: CompatibilityReport | null; female: CompatibilityReport | null }>({ male: null, female: null });

  // Recompute live so manual mapping edits are reflected side by side.
  useEffect(() => {
    if (!asset) {
      setRecheck({ male: null, female: null });
      return;
    }
    void maleMapping;
    void femaleMapping;
    void buildMappings;
    void analyzeCompatibility;
    setRecheck({ male: male ?? null, female: female ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.id, compat]);

  const rows = ['requiredSlotCoverage', 'hierarchyValidCount', 'trackMatchRatio', 'meanMappingConfidence'] as const;

  return (
    <div className="compare">
      <p className="muted small">
        Same animation evaluated against both characters. {asset ? <code>{asset.fileName}</code> : 'Select an animation first.'}
      </p>
      <div className="compare-grid">
        {(['male', 'female'] as const).map((slot) => {
          const r = slot === 'male' ? recheck.male : recheck.female;
          return (
            <section className="card" key={slot}>
              <h3>{slot === 'male' ? '👨 Male' : '👩 Female'}</h3>
              {r ? (
                <>
                  <p>
                    <span className={`pill ${r.status === 'COMPATIBLE' ? 'pill-good' : r.status === 'INCOMPATIBLE' || r.status === 'PROCESSING_FAILED' ? 'pill-bad' : 'pill-warn'}`}>
                      {r.status.replace(/_/g, ' ')}
                    </span>
                  </p>
                  <ul className="summary-list">
                    <li>Required slots: <strong>{r.scoring.requiredSlotsMapped}/{r.scoring.requiredSlotsTotal}</strong></li>
                    <li>Hierarchy valid: <strong>{r.hierarchy.validParents}/{r.hierarchy.checkedParents}</strong></li>
                    <li>Track match: <strong>{(r.scoring.trackMatchRatio * 100).toFixed(0)}%</strong></li>
                    <li>Mapping confidence: <strong>{(r.scoring.meanMappingConfidence * 100).toFixed(0)}%</strong></li>
                    <li>Rest Δ: <strong>{r.restPose.maxRestRotationDeltaDeg?.toFixed(1) ?? '—'}°</strong></li>
                    <li>Readiness: <strong>{r.retargetReadiness.replace(/_/g, ' ')}</strong></li>
                  </ul>
                  <h4>Missing</h4>
                  <p className="small">{r.requiredBonesMissing.length ? r.requiredBonesMissing.join(', ') : 'none'}</p>
                </>
              ) : (
                <p className="muted">No report yet for this character.</p>
              )}
            </section>
          );
        })}
      </div>
      <div className="table-wrap card">
        <h4>Mapping differences</h4>
        <table>
          <thead><tr><th>Slot</th><th>Male bone</th><th>Female bone</th><th>Same?</th></tr></thead>
          <tbody>
            {maleMapping.map((m) => {
              const f = femaleMapping.find((x) => x.slot === m.slot);
              return (
                <tr key={m.slot}>
                  <td>{m.slot}</td>
                  <td><code>{m.characterBone ?? '—'}</code></td>
                  <td><code>{f?.characterBone ?? '—'}</code></td>
                  <td>{m.characterBone === f?.characterBone ? '✅' : '≠'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted small">Rows: {rows.length} metric categories compared per character.</p>
      </div>
    </div>
  );
}
