# Character Skeleton Inspector — Phase 1 (GLTF + BIN)

Mobile-first web app (Android Chrome + desktop) that **structurally inspects** uploaded
`.gltf + .bin` character bundles in the browser with Three.js (`THREE.GLTFLoader`).
It reports skeleton, skinning, bind pose, humanoid bone coverage and texture status,
and renders the character + skeleton in an interactive 3D viewer.

> **⚠️ This is NOT Unity Editor.** Phase 1 does **not** run Unity `AvatarBuilder`,
> Mecanim muscle setup, Unity runtime verification, animation playback, retargeting,
> or auto-rigging. Humanoid results are **heuristic** name/hierarchy analysis and are
> **not** a guarantee of Unity Humanoid compatibility. Confirmed facts are always
> shown separately from heuristic findings in the report.

## Repository characters (1-tap load)

The uploaded bundles are served read-only under `./repo-characters/` (no binaries duplicated in Git):

| Slot | Source |
|---|---|
| **Male Character** | `Character/Male/Superhero_Male_FullBody.gltf` + `.bin` + 8 PNGs + `License_Standard.txt` |
| **Female Character** | `Character/Female/Superhero_Female_FullBody.gltf` + `.bin` + 8 PNGs + `License_Standard(1).txt` |

Latest verified inspection (7/7 textures loaded for both slots, verified in a real browser):
`inspector/reports/male-inspection-report.{json,html}` and
`inspector/reports/female-inspection-report.{json,html}`.

In dev, `vite.config.ts` (`repoCharactersPlugin`) serves `../Character/{Male,Female}` at
`/repo-characters/`; in production builds the same files are copied into `dist/repo-characters/`
with a generated `manifest.json`. The UI fetches the manifest and loads the bundle with one tap —
the exact same inspection path as a manual upload.

## Upload (per slot)

Select **all files together**: `.gltf` + `.bin` + external textures (`.png/.jpg/.jpeg/.webp`) +
optional `licence.txt` / `License*.txt`. The engine validates JSON, `.bin` existence/size,
external texture resolution (exact path → basename fallback → transparent near-match), and load
errors — it never assumes textures are embedded. Every material texture assignment is reported
explicitly (`baseColorTexture`, `normalTexture`, `metallicRoughnessTexture`, `occlusionTexture`,
`emissiveTexture`) per material, together with the glTF image URI, the file that satisfied it,
the resolution mode (`exact_path` / `basename_fallback` / `near_match` / `embedded`) and the load
status. Near-match resolutions (e.g. glTF asks for `T_Hair_1_Normal_png.png` while the uploaded
file is `T_Hair_1_Normal.png`) still load, but are surfaced as `TEXTURE_FILENAME_NEAR_MATCH`
warnings so a filename discrepancy is never silently hidden. **Files are inspected only in browser memory**: never modified,
never committed, never sent to external services. Clear/Remove calls `session.dispose()`
(revokes object URLs, disposes geometries/materials/textures).

## What the engine checks (`src/engine/`)

- **Skeleton detection** — `skins`, `joints`, `inverseBindMatrices`, `THREE.Skeleton`, `SkinnedMesh`, mesh↔skeleton connection.
- **Per-skeleton bone info** — name/ID, count, names, parent–child hierarchy, root bone(s), depth, duplicate/empty/unusual names (e.g. Blender `*_leaf_*` end bones).
- **Skinning validation** — `JOINTS_0`/`WEIGHTS_0` presence, index bounds, non-negative/finite weights, normalized vs unnormalized (sum ≠ 1.0), zero-influence vertices, mesh–skeleton consistency, unweighted vertices. Uploaded files are never mutated.
- **Bind pose & rig structure** — IBM count/finiteness/invertibility, rest transforms, hierarchy, root structure, naming convention (Mixamo, Unreal Mannequin, Blender Rigify, VRM, CC, Biped).
- **Humanoid analysis** — 19 slots (`Hips`, `Spine`, `Chest`, `Neck`, `Head`, `Left/Right Shoulder`, `Left/Right Upper Arm`, `Left/Right Lower Arm`, `Left/Right Hand`, `Left/Right Upper Leg`, `Left/Right Lower Leg`, `Left/Right Foot`) each classified `Found` / `Missing` / `Possible match` / `Ambiguous`.

### Exact report statuses

`Skeleton: Present/Missing` · `Skinned Mesh: Present/Missing` · `Bone Weights: Valid/Invalid/Missing` ·
`Bone Hierarchy: Valid/Issues Found` · `Bind Pose: Available/Missing/Invalid` ·
`Humanoid Structure: Likely/Incomplete/Unknown` · `Textures: Loaded/Missing/Failed`

### Final classifications

`RIGGED_AND_SKINNED` · `SKELETON_PRESENT_BUT_NOT_SKINNED` · `SKELETON_PRESENT_WITH_WEIGHT_ISSUES` ·
`SKELETON_MISSING` · `INVALID_OR_INCOMPLETE_GLTF`

Reports export as **JSON** and readable **HTML** (buttons in each report panel).

## 3D viewer

Three.js + `OrbitControls`: rotate, zoom, pan, reset camera, show/hide `SkeletonHelper`,
show/hide wireframe, tap/click a bone (or a bone name in the report) to highlight it,
textures/materials as loaded, plus loading/error/empty states. Touch gestures work on Android Chrome.

## Run locally

```bash
cd inspector
npm install
npm run dev      # http://localhost:5173 (host 0.0.0.0)
npm test         # Vitest: synthetic fixtures + real Character/Male & Character/Female
npm run build    # production build -> dist/ (includes repo-characters/)
```

## Tests (`tests/`)

`gltfFixtures.ts` builds tiny synthetic `.gltf + .bin` bundles in memory;
`inspectCharacter.test.ts` covers: no skeleton, valid skeleton + `SkinnedMesh`,
skeleton-not-skinned, missing BIN, missing texture, invalid skin indices,
unnormalized weights, negative weights, duplicate bone names, incomplete humanoid,
valid humanoid-like skeleton, invalid JSON, licence handling — **plus** integration tests
against the real `Character/Male/` and `Character/Female/` bundles.

## Deployment (GitHub Pages)

`.github/workflows/deploy-character-inspector.yml` builds `inspector/` and deploys `dist/`
to GitHub Pages (pinned action SHAs, minimal `contents: read` + `pages: write` permissions).
Enable it under **Settings → Pages → Source: GitHub Actions**.

## Separation from the FBX pipeline

`animations/*.fbx`, `animations/*.fbx.meta`, `.github/workflows/generate-animation-meta.yml`,
`scripts/`, `tests/` (Python) and `Character/` are **untouched** by this app.
`inspector/dist/`, `inspector/node_modules/` and `inspector/.vite/` are git-ignored.

## Browser vs Unity limitations

- No Unity `AvatarBuilder`/Mecanim validation, no muscle-space checks, no Unity runtime test.
- Bone-name heuristics cannot prove Unity Humanoid compatibility (root motion, twist bones, IK, muscle limits are not checked).
- glTF `KHR_*` extensions beyond what `GLTFLoader` supports may load partially; missing textures fall back to a 1×1 preview so the skeleton can still be inspected.
- Inspection is structural only: no animation playback, retargeting, or rigging in Phase 1.
