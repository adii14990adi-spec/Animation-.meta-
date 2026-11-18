import { useCallback, useRef, useState } from 'react';
import { inspectCharacterBundle } from './engine/inspectCharacter';
import { fetchRepoCharacterFiles, fetchRepoCharacterManifest } from './engine/repoCharactersClient';
import type { CharacterSlotId, LoadedCharacterSession } from './engine/types';
import CharacterViewer from './components/CharacterViewer';
import ReportPanel from './components/ReportPanel';

interface SlotState {
  session: LoadedCharacterSession | null;
  loading: boolean;
  error: string | null;
  fileNames: string[];
  selectedBone: string | null;
}

const initialState: SlotState = { session: null, loading: false, error: null, fileNames: [], selectedBone: null };

const SLOT_META: Record<CharacterSlotId, { label: string; repoDir: string; emoji: string }> = {
  male: { label: 'Male Character', repoDir: 'Male', emoji: '👨' },
  female: { label: 'Female Character', repoDir: 'Female', emoji: '👩' },
};

function SlotCard({ slot }: { slot: CharacterSlotId }) {
  const meta = SLOT_META[slot];
  const [state, setState] = useState<SlotState>(initialState);
  const inputRef = useRef<HTMLInputElement>(null);
  const runIdRef = useRef(0);

  const clearSession = useCallback(() => {
    setState((prev) => {
      prev.session?.dispose();
      return initialState;
    });
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const runInspection = useCallback(async (files: File[], sourceLabel: string) => {
    const runId = ++runIdRef.current;
    setState((prev) => {
      prev.session?.dispose();
      return { ...initialState, loading: true, fileNames: files.map((f) => f.name) };
    });
    try {
      const session = await inspectCharacterBundle(files, slot, sourceLabel);
      if (runIdRef.current !== runId) {
        session.dispose();
        return;
      }
      setState({ session, loading: false, error: null, fileNames: files.map((f) => f.name), selectedBone: null });
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setState({
        ...initialState,
        error: err instanceof Error ? err.message : 'Inspection failed unexpectedly.',
        fileNames: files.map((f) => f.name),
      });
    }
  }, [slot]);

  const onFilesChosen = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    void runInspection(Array.from(fileList), 'Local Browser Upload');
  };

  const loadRepoCharacter = async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const manifest = await fetchRepoCharacterManifest();
      if (!manifest) throw new Error('Repository character manifest not found (./repo-characters/manifest.json).');
      const paths = slot === 'male' ? manifest.male : manifest.female;
      if (paths.length === 0) throw new Error(`No files in Character/${meta.repoDir}/.`);
      const files = await fetchRepoCharacterFiles(slot, paths);
      await runInspection(files, `Repository Character/${meta.repoDir}`);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load repository character.',
      }));
    }
  };

  return (
    <section className="slot-card" aria-label={meta.label}>
      <header className="slot-head">
        <h2>{meta.emoji} {meta.label}</h2>
        {state.session && (
          <span className="muted">Source: {state.session.sourceLabel}</span>
        )}
      </header>

      <div className="upload-box">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".gltf,.bin,.png,.jpg,.jpeg,.webp,.txt"
          onChange={(e) => onFilesChosen(e.target.files)}
          aria-label={`Upload ${meta.label} files`}
        />
        <p className="muted">
          Select all files together: <code>.gltf</code> + <code>.bin</code> + external textures (<code>.png/.jpg</code>) + optional <code>licence.txt</code>.
          Files stay in your browser — never uploaded, never committed.
        </p>
        <div className="upload-actions">
          <button type="button" className="btn btn-primary" onClick={() => void loadRepoCharacter()} disabled={state.loading}>
            ▶ Load repository character (Character/{meta.repoDir})
          </button>
          {(state.session || state.fileNames.length > 0) && (
            <button type="button" className="btn" onClick={clearSession} disabled={state.loading}>
              🗑 Clear / Remove
            </button>
          )}
        </div>
        {state.fileNames.length > 0 && (
          <ul className="file-list">
            {state.fileNames.map((n) => <li key={n}><code>{n}</code></li>)}
          </ul>
        )}
      </div>

      <CharacterViewer
        session={state.session}
        loading={state.loading}
        error={state.error}
        selectedBoneName={state.selectedBone}
        onSelectBone={(name) => setState((prev) => ({ ...prev, selectedBone: name }))}
      />

      {state.session && (
        <ReportPanel
          report={state.session.report}
          onSelectBone={(name) => setState((prev) => ({ ...prev, selectedBone: name }))}
        />
      )}
    </section>
  );
}

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>🦴 Character Skeleton Inspector</h1>
        <p className="subtitle">Phase 1 — GLTF + BIN structural inspection (browser only)</p>
        <div className="notice" role="note">
          <strong>⚠️ This is NOT Unity Editor.</strong> Results are browser-based structural inspection of the
          <code> .gltf + .bin</code> package (skeleton, skinning, bind pose, textures). Humanoid matches are
          <em> heuristic</em> name/hierarchy analysis — not Unity <code>AvatarBuilder</code> validation and not a
          guarantee of Unity Humanoid compatibility. Animation playback, retargeting and auto-rigging are out of scope for Phase 1.
        </div>
      </header>

      <main className="slots">
        <SlotCard slot="male" />
        <SlotCard slot="female" />
      </main>

      <footer className="app-footer">
        <p>
          Existing FBX animation pipeline (<code>animations/*.fbx</code>, <code>*.fbx.meta</code>,{' '}
          <code>generate-animation-meta.yml</code>) is untouched and separate from this inspector.
          Uploaded files are inspected locally in memory and disposed on Clear/Remove.
        </p>
      </footer>
    </div>
  );
}
