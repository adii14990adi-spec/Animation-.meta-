# Automated Unity FBX Animation Metadata Generator

A standalone, production-ready GitHub Actions automation system that inspects uploaded **FBX animation assets**, generates and maintains genuine **Unity `ModelImporter` `.meta` files**, validates GUID uniqueness/stability and importer serialization, and commits the resulting metadata back to the repository automatically.

---

## Table of Contents

1. [What the System Does](#1-what-the-system-does)
2. [How the Repository Works](#2-how-the-repository-works)
3. [How to Upload FBX Animation Files](#3-how-to-upload-fbx-animation-files)
4. [How GitHub Actions Starts Automatically](#4-how-github-actions-starts-automatically)
5. [How `.meta` Files Are Generated](#5-how-meta-files-are-generated)
6. [How GUID Persistence Works](#6-how-guid-persistence-works)
7. [How to Configure Importer Settings & Rules](#7-how-to-configure-importer-settings--rules)
8. [How Humanoid and Generic Classification Works](#8-how-humanoid-and-generic-classification-works)
9. [How to Inspect Workflow Results](#9-how-to-inspect-workflow-results)
10. [How to Troubleshoot Errors](#10-how-to-troubleshoot-errors)
11. [What Requires Unity Editor Validation](#11-what-requires-unity-editor-validation)
12. [Git LFS Setup and Limitations](#12-git-lfs-setup-and-limitations)

---

## 1. What the System Does

When animators or developers upload `.fbx` animation clips into `animations/`, this repository automatically:

1. **Inspects every changed FBX** (both Autodesk Binary FBX `v6.x–v7.7+` 32/64-bit and ASCII FBX) to verify structural integrity and extract frame rate, take names, keyframe duration, frame counts, embedded geometry, and skeleton bone hierarchy.
2. **Classifies rig compatibility** (`Humanoid`, `Generic`, or `Unknown`) from the actual FBX skeleton hierarchy rather than blindly forcing every asset to Humanoid.
3. **Applies Battle Royale / shooter animation presets** (`Idle`, `Walk`, `Run`, `Sprint`, `Jump`, `Fall`, `Crouch`, `Aim`, `Shoot`, `Reload`, `Melee`, `Death`, `Hit Reaction`, `Weapon Handling`, `Other`) for clip loop and root-motion settings, with full user override support.
4. **Serializes authentic Unity `ModelImporter` `.meta` files** (`fileFormatVersion: 2`, 32-hex GUID, `ModelImporter`, `clipAnimations`, `humanDescription`, `meshes`, `materials`, `tangentSpace`).
5. **Validates the entire repository** (GUID format, global uniqueness, cross-commit GUID stability, orphaned `.meta` cleanup on FBX deletion, and Unity schema rules).
6. **Commits only necessary `.meta` changes** back to the branch without modifying `.fbx` source files or triggering infinite workflow loops.

### Strict Scope

- **Supported:** Standalone `.fbx` animation files inside `animations/`.
- **Out of scope:** Static character meshes without animation data, character creation/rigging, paid external APIs, or coupling to the main Battle Royale Unity game repository.

---

## 2. How the Repository Works

### Pipeline Architecture

```text
FBX Upload (animations/**/*.fbx)
        │
        ▼
GitHub Actions Trigger (.github/workflows/generate-animation-meta.yml)
        │
        ▼
FBX Analysis (scripts/analyze_fbx.py)
  ├─ Binary (32/64-bit, zlib) & ASCII FBX streaming parser
  ├─ Frame rate, takes, start/end frames, keyframe curves
  └─ Skeleton hierarchy & Humanoid / Generic / Unknown rig check
        │
        ▼
Metadata Generation (scripts/generate_meta.py)
  ├─ Deterministic UUIDv5 GUIDs for new assets
  ├─ Existing .meta & Git/cache rename GUID preservation
  └─ Unity ModelImporter YAML emitter (scripts/utils.py)
        │
        ▼
Comprehensive Validation (scripts/validate_meta.py)
  ├─ Static Unity ModelImporter schema & GUID stability checks
  └─ Optional Unity Editor -batchmode import check (scripts/unity_batch_validate.py)
        │
        ▼
Automatic Git Commit (animations/**/*.meta only, [skip ci])
```

### Repository Structure

```text
.
├── animations/                 # Upload FBX animation files here (subfolders supported)
│   └── .gitkeep
├── config/
│   ├── importer_settings.json  # Global Unity ModelImporter, rig, mesh, and clip defaults
│   └── animation_rules.json    # Category pattern rules & explicit per-asset overrides
├── scripts/
│   ├── analyze_fbx.py          # Standalone Binary/ASCII FBX inspector & rig classifier
│   ├── generate_meta.py        # Incremental/full Unity .meta generator & orphan cleaner
│   ├── validate_meta.py        # Repository validator & Markdown/JSON report generator
│   ├── unity_batch_validate.py # Optional Unity Editor -batchmode validation harness
│   └── utils.py                # Unity YAML parser/serializer, GUID, cache, and Git helpers
├── reports/                    # Output directory for local/CI JSON & Markdown reports (gitignored)
│   └── .gitkeep
├── tests/                      # Synthetic FBX fixture builder & pytest test suite
│   ├── fbx_synthetic.py
│   ├── test_guid.py
│   ├── test_metadata.py
│   └── test_validation.py
├── .github/
│   └── workflows/
│       └── generate-animation-meta.yml
├── requirements.txt
├── .gitignore
└── README.md
```

---

## 3. How to Upload FBX Animation Files

You can upload single or multiple `.fbx` files at once, either directly into `animations/` or organized into subfolders (such as `animations/locomotion/`, `animations/weapons/`, `animations/combat/`).

### Option A: Upload via GitHub Web UI

1. Open the `animations/` folder in GitHub.
2. Click **Add file → Upload files**.
3. Drag and drop one or more `.fbx` animation files (for example `Idle.fbx`, `Soldier@Run.fbx`, `Rifle_Reload.fbx`).
4. Commit directly to your branch (or open a Pull Request).
5. GitHub Actions automatically runs and commits `Idle.fbx.meta`, `Soldier@Run.fbx.meta`, and `Rifle_Reload.fbx.meta`.

### Option B: Upload via Git CLI (Batch Upload)

```bash
cp ~/exports/*.fbx animations/
git add animations/*.fbx
git commit -m "feat(anim): add locomotion and reload FBX clips"
git push origin main
# Pull back the automatically generated .meta files once the workflow finishes:
git pull --rebase origin main
```

### Naming Tips

- **`ModelName@ClipName.fbx` Convention:** Files named like `Y Bot@Sprint.fbx` automatically name the extracted Unity `AnimationClip` `Sprint` (controlled by `strip_at_prefix: true`).
- **Spaces, Special Characters, and Unicode:** Filenames like `Crouch Walk (Aim) #1.fbx` or `걷기_Walk.fbx` are handled safely using NFC Unicode normalization and proper YAML scalar quoting.
- **Renaming / Moving Assets:** Prefer `git mv animations/Old.fbx animations/New.fbx` when renaming so Git rename tracking preserves the exact original GUID automatically (content-hash fallback also detects uncommitted moves).

---

## 4. How GitHub Actions Starts Automatically

The workflow `.github/workflows/generate-animation-meta.yml` runs automatically on:

- **`push`** when files matching `animations/**/*.fbx` (case-insensitive `.fbx`/`.FBX`/`.Fbx`), `animations/**/*.meta`, or `config/*.json` are added, modified, renamed, or deleted.
- **`workflow_dispatch`** (manual execution from the **Actions** tab) with three optional inputs:
  - `mode`: `full` (scans all FBX files) or `incremental` (processes Git-changed and missing-meta FBX files).
  - `reconfigure_existing`: `true` to re-apply updated `config/*.json` importer settings to existing `.meta` files while **strictly preserving existing GUIDs**.
  - `dry_run`: `true` to run analysis and validation reports without committing changes.

### Safeguards Built Into the Workflow

- **No Unnecessary Runs:** Editing `README.md`, `tests/`, or unrelated files does not trigger the workflow.
- **Triple-Layered Loop Prevention:**
  1. Pushes use `GITHUB_TOKEN`, which GitHub Actions does not re-trigger on `push`.
  2. Job-level `if:` skips `github-actions[bot]` commits and `[skip ci]` messages.
  3. Automation commits use `chore: generate Unity metadata for FBX animations [skip ci]` and skip committing when `git diff --cached --quiet` reports zero changes.
- **Concurrency Serialization:** `concurrency` queues runs per branch (`cancel-in-progress: false`) and rebases before pushing so simultaneous uploads never corrupt metadata.
- **Security Hardening:** Third-party Actions are pinned to verified 40-character commit SHAs with minimal `contents: write` job scope.

---

## 5. How `.meta` Files Are Generated

Generated `.meta` files follow **Unity's native `ModelImporter` YAML serialization** (verified against Unity 2021 LTS / 2022 LTS / Unity 6 `ModelImporter` schema), never invented JSON or generic YAML:

```yaml
fileFormatVersion: 2
guid: 003bb53a6f02523c91485859f3e6c2cd
ModelImporter:
  serializedVersion: 22200
  internalIDToNameTable: []
  externalObjects: {}
  materials:
    materialImportMode: 0
    materialName: 0
    materialSearch: 1
    materialLocation: 1
  animations:
    legacyGenerateAnimations: 4
    bakeSimulation: 0
    resampleCurves: 1
    ...
    animationCompression: 3
    clipAnimations:
    - serializedVersion: 16
      name: Idle
      takeName: mixamo.com
      internalID: 0
      firstFrame: 0
      lastFrame: 60
      ...
      loopTime: 1
      loopBlend: 1
      bodyMask: 01000000010000000100000001000000010000000100000001000000010000000100000001000000010000000100000001000000
      ...
      maskType: 3
      maskSource: {instanceID: 0}
```

Key serialization guarantees in `scripts/utils.py`:

- **No YAML 1.1 Octal Corruption:** Unity's 104-character hex `bodyMask` (`01000000...`) is preserved as a raw hex byte string rather than being coerced into an octal integer by standard YAML 1.1 loaders.
- **No GUID Type Mangling:** 32-character hex GUIDs with leading zeros (`003bb...`) or exponent-like substrings (`...e12...`) are never parsed as numbers or `inf`.
- **No Boolean Norway-Problem Corruption:** Clip or bone names like `Off`, `On`, `No`, or `Yes` remain strings.
- **Bind-Pose Filtering:** Helper takes like `T-Pose` or `Armature|T-Pose` are automatically skipped when real animation takes exist in the same FBX.

---

## 6. How GUID Persistence Works

Unity identifies every asset and sub-asset reference by the 32-character lowercase hexadecimal `guid` inside `<Asset>.fbx.meta`. Changing an existing asset's GUID breaks AnimatorControllers, Timeline tracks, and Prefab references in Unity.

Our GUID lifecycle rules enforce strict stability:

1. **Existing `.meta` Preservation:** If `Run.fbx.meta` already exists and is valid, its `guid` (along with Unity-populated `internalIDToNameTable`, `externalObjects`, `userData`, and custom `humanDescription` / clip `events`) is **never** overwritten on subsequent runs—even if `Run.fbx` is re-exported with updated keyframes.
2. **Deterministic New Asset GUIDs:** Brand-new FBX files receive a deterministic RFC 4122 **UUIDv5** hex digest derived from `guid_namespace` (in `config/importer_settings.json`) and the NFC-normalized repository-relative path (`animations/Run.fbx`).
3. **Rename & Move Recovery:** When an FBX is renamed or moved:
   - Git diff rename tracking (`git diff -M85%`) and historical `<base_sha>:<old_path>.meta` lookup recover the original `.meta` and `guid`—even if the old `.meta` was deleted in the same commit.
   - Outside Git (or for uncommitted moves), the SHA-256 asset cache (`.cache/fbx_meta_cache.json`) matches unambiguously moved files and migrates their GUID while deleting the orphaned `.meta`.
   - **Copy vs. Rename:** If `Walk.fbx` is *copied* to `Walk_Copy.fbx` while `Walk.fbx` still exists, `Walk_Copy.fbx` receives a **new** unique GUID so duplicates are never created.
4. **Accidental `.meta` Deletion Recovery:** If someone accidentally deletes `Walk.fbx.meta` while `Walk.fbx` remains, `generate_meta.py` checks Git `HEAD` and `.cache` first to restore its exact previous GUID (including legacy Unity GUIDs).
5. **Global Collision Detection:** Every run scans all `.meta` files in the repository. Duplicate GUIDs across existing assets trigger an immediate critical validation failure rather than silently mutating an asset's GUID.

---

## 7. How to Configure Importer Settings & Rules

### Global Importer Settings (`config/importer_settings.json`)

Controls default `ModelImporter` settings across all newly generated `.meta` files:

```json
{
  "preserve_existing_meta": true,
  "update_clips_when_fbx_changes": true,
  "clean_orphaned_meta": true,
  "animation_import": {
    "enabled": true,
    "resample_curves": true,
    "animation_compression": "Optimal",
    "rotation_error": 0.5,
    "position_error": 0.5,
    "scale_error": 0.5,
    "remove_constant_scale_curves": true
  },
  "mesh_import": {
    "disable_for_animation_only": true,
    "import_blend_shapes": false,
    "optimize_bones": true
  },
  "rig_settings": {
    "auto_detect": true,
    "humanoid_confidence_threshold": 0.85,
    "humanoid": {
      "avatar_setup": "CreateFromThisModel",
      "source_avatar_guid": "",
      "source_avatar_file_id": 9000000
    },
    "generic": {
      "avatar_setup": "CreateFromThisModel",
      "root_motion_bone_name": ""
    },
    "unknown_rig_policy": "fallback_generic_with_warning"
  }
}
```

### Category Rules & Per-Asset Overrides (`config/animation_rules.json`)

`config/animation_rules.json` defines heuristic filename/take-name patterns for 15 categories (`Idle`, `Walk`, `Run`, `Sprint`, `Jump`, `Fall`, `Crouch`, `Aim`, `Shoot`, `Reload`, `Melee`, `Death`, `Hit Reaction`, `Weapon Handling`, `Other`).

> **Note:** Filename patterns only suggest default importer settings (such as `loop_time: true` for `Run` vs `loop_time: false` for `Reload`). They do not prove visual animation behavior.

To explicitly override any specific file or glob pattern, add an entry under `asset_overrides` in `config/animation_rules.json`:

```json
{
  "asset_overrides": {
    "animations/boss/Boss_JumpSlam.fbx": {
      "category": "Melee",
      "rig_type": "Humanoid",
      "avatar_setup": "CopyFromOther",
      "source_avatar_guid": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      "source_avatar_file_id": 9000000,
      "first_frame": 4,
      "last_frame": 52,
      "loop_time": false,
      "root_transform_position_y": {
        "bake_into_pose": false,
        "based_upon": "Original",
        "offset": 0.0
      }
    },
    "animations/weapons/*.fbx": {
      "rig_type": "Generic",
      "root_motion_bone_name": "WeaponRoot"
    }
  }
}
```

To apply updated rules to already-existing `.meta` files (without changing any GUIDs), run:

```bash
python scripts/generate_meta.py --reconfigure
python scripts/validate_meta.py
```

---

## 8. How Humanoid and Generic Classification Works

`scripts/analyze_fbx.py` inspects the FBX `Objects` (`Model`, `NodeAttribute`, `Deformer` skin clusters) and `Connections` parent-child tree:

| Classification | Criteria | Generated Unity Settings |
| :--- | :--- | :--- |
| **`Humanoid`** | All **15 mandatory Unity Mecanim bones** (`Hips`, `Spine`, `Head`, `Left/RightUpperLeg`, `Left/RightLowerLeg`, `Left/RightFoot`, `Left/RightUpperArm`, `Left/RightLowerArm`, `Left/RightHand`) are present (supporting Mixamo, HIK, Biped, Unreal, Rigify, CC, and VRM naming conventions) **and** pass anatomical parent-child hierarchy verification. | `animationType: 3` (`Human`), `avatarSetup: 1` (`CreateFromThisModel`, or `2` `CopyFromOther` if `source_avatar_guid` is configured), `autoGenerateAvatarMappingIfUnspecified: 1`, accurate `hasExtraRoot`. |
| **`Generic`** | Contains a valid skeleton or animated `Model` hierarchy, but has fewer than 15 Humanoid bones or a non-humanoid topology (weapons, supply crates, quadrupeds, vehicles, props, cameras). | `animationType: 2` (`Generic`), `avatarSetup: 1` (`CreateFromThisModel`), optional `motionNodeName`. |
| **`Unknown`** | Contains animation curves without an identifiable skeleton or animated `Model` hierarchy. | Never forced to Humanoid. Uses `unknown_rig_policy` (default: safe `Generic` `animationType: 2` with `avatarSetup: 0` `NoAvatar` + diagnostic warning, or `fail` in strict mode). |

---

## 9. How to Inspect Workflow Results

Every GitHub Actions run surfaces results in two places:

1. **GitHub Actions Job Summary (`$GITHUB_STEP_SUMMARY`):**
   Open the workflow run in the **Actions** tab to view a formatted Markdown summary table showing total FBX files, analyzed count, generated `.meta` count, preserved `.meta` count, invalid files, duplicate GUIDs, validation tier (`static_only` vs `static_and_unity_editor`), and any warnings or errors.
2. **Downloadable Workflow Artifacts (`fbx-animation-meta-reports-<run>`):**
   - `reports/analysis_report.json` — Per-file FBX version, FPS, takes, duration, frame counts, mesh vertex count, bone list, rig classification confidence, and category suggestion.
   - `reports/generation_report.json` — Lists of generated, updated, rename-migrated, preserved, orphaned-removed, and failed assets.
   - `reports/validation_report.json` & `reports/validation_summary.md` — Complete validation audit.

### Running Locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 1. Inspect FBX files only
python scripts/analyze_fbx.py animations --output reports/analysis_report.json

# 2. Generate / update .meta files
python scripts/generate_meta.py --repo-root .

# 3. Validate repository metadata & GUID integrity
python scripts/validate_meta.py --repo-root .

# 4. Run automated unit & integration tests
pytest -v
```

---

## 10. How to Troubleshoot Errors

When a critical validation check fails, the workflow exits non-zero **before** committing so broken metadata never enters the branch. Valid FBX files in the same batch are still processed cleanly without cross-file corruption.

| Error Code | Cause | Resolution |
| :--- | :--- | :--- |
| `NO_ANIMATION_DATA` | Uploaded `.fbx` contains no animation takes/keyframes (e.g., a static character or prop mesh). | Export the FBX with baked/keyframed animation curves; do not upload static character models here. |
| `GIT_LFS_POINTER` | The `.fbx` on disk is a text Git LFS pointer rather than actual FBX bytes. | Run `git lfs pull` locally and ensure Git LFS quota is not exceeded on GitHub. |
| `EMPTY_FILE` / `CORRUPTED_FBX` | Zero-byte, truncated, or corrupted zlib/node stream inside `.fbx`. | Re-export the FBX (Binary FBX 7.4 / 2014–2020 recommended) from Blender/Maya/MotionBuilder. |
| `UNSUPPORTED_FBX_VERSION` | Legacy FBX `< 6.0` (`< 6000`). | Re-export using FBX 7.1–7.7 (`7100–7700`). |
| `DUPLICATE_GUID` | Two `.meta` files share the same 32-hex GUID (e.g., someone manually copied a `.meta` file). | Delete the copied `.meta` on the new asset and re-run `generate_meta.py` so it gets its own unique GUID. |
| `GUID_INSTABILITY` | An existing asset's `.meta` GUID was modified relative to Git `HEAD`. | Restore the original GUID reported in the error message (`git checkout HEAD -- <file>.meta`). |
| `INCOMPATIBLE_HUMANOID_RIG` | `.meta` sets `animationType: 3` (Humanoid) on a non-humanoid skeleton without an override. | Change `animationType` to `2` (Generic) or configure an explicit `rig_type` override in `config/animation_rules.json`. |
| `UNSUPPORTED_ASSET_IN_ANIMATIONS` | Non-FBX file (e.g., `.blend`, `.obj`, `.png`) placed inside `animations/`. | Remove non-FBX files from `animations/`. |

---

## 11. What Requires Unity Editor Validation

### Important Technical Limitation

Static `.meta` generation and validation verify:
- Valid Unity `ModelImporter` YAML syntax, types, and value ranges
- Deterministic, globally unique, and stable 32-hex GUIDs
- FBX file integrity, take frame ranges, and 15-bone Humanoid hierarchy presence

However, **a `.meta` file alone cannot guarantee runtime Humanoid Avatar T-pose validity or muscle retargeting quality**:
1. Unity's native C++ `AvatarBuilder` inspects actual rest/bind-pose bone rotations inside the FBX during import to verify that the skeleton is close enough to a T-pose and has non-zero bone lengths.
2. Notice that Unity's own `ModelImporter` relies on `disable_for_animation_only` disabling materials, cameras, lights, normals, tangents, and blendshapes in `.meta`, whereas completely stripping embedded `Geometry` mesh nodes from an FBX exported *"With Skin"* either happens at DCC export time (*"Without Skin"*) or via an `AssetPostprocessor` inside Unity.
3. Retargeting artifacts (foot sliding, shoulder twist, IK drift) can only be evaluated once Unity imports the clip against your target character `Avatar`.

### Optional Unity Editor Batch-Mode Validation

No Unity Editor installation or license is required on standard GitHub-hosted runners (`validate_meta.py` clearly marks `validation_mode: "static_only"`). If you run a self-hosted runner or local machine with an activated Unity Editor installed, enable full runtime `ModelImporter` + `Avatar.isValid` validation with:

```bash
export UNITY_EDITOR_PATH="/opt/unity/Editor/Unity"
python scripts/validate_meta.py --repo-root .
```

When `UNITY_EDITOR_PATH` (or `--unity-editor`) is provided, `scripts/unity_batch_validate.py` stages all `.fbx` + `.fbx.meta` pairs into an isolated temporary Unity project, runs `Unity -batchmode -nographics -quit -executeMethod FbxMetaBatchValidator.Run`, and fails validation if Unity reports `rigImportErrors`, `animationImportErrors`, `0` imported clips, or an invalid Humanoid `Avatar`.

---

## 12. Git LFS Setup and Limitations

The GitHub Actions workflow already sets `lfs: true` on `actions/checkout`, so repositories with or without Git LFS work seamlessly.

### When to Enable Git LFS

- Recommended if individual `.fbx` files exceed **10–50 MB** or total repository size grows past **1 GB** (e.g., 500+ dense mocap FBX files).
- Optional for lightweight skeleton-only FBX clips (typically 50 KB – 500 KB each).

### Enabling Git LFS for `.fbx` Files

```bash
git lfs install
git lfs track "animations/**/*.fbx"
git lfs track "animations/**/*.FBX"
git add .gitattributes
git commit -m "chore: track FBX animation files with Git LFS"
```

> **Important:** Never track `*.meta` files in Git LFS! Unity `.meta` files are small plain-text YAML files that must remain regular Git-tracked text files for diffing, merge resolution, and fast GUID scanning.

### Git LFS Limitations on GitHub

- GitHub Free accounts include limited monthly Git LFS storage and bandwidth; every CI checkout with `lfs: true` consumes LFS bandwidth proportional to fetched LFS blobs.
- If LFS quota is exhausted or someone pushes an unpulled pointer, `analyze_fbx.py` immediately detects the pointer header (`GIT_LFS_POINTER`) and fails with a clear diagnostic rather than generating invalid metadata.
