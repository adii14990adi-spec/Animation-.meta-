## Summary

Adds the 74 authoritative Unity `.fbx.meta` files from
[`adii14990adi-spec/Animation-.meta-`](https://github.com/adii14990adi-spec/Animation-.meta-)
beside their exact-name FBX counterparts under `unity-project/Assets/Animations/`,
and makes that copy permanent and automatic.

**Result:** 74 added · 0 updated · 0 skipped · 0 failed · **0 `.fbx` files touched.**

## What changed

| Group | Files |
| --- | ---: |
| `unity-project/Assets/Animations/**/*.fbx.meta` | 74 added |
| `processing/animation-metadata/` (sync script, manifest, 26 tests) | 3 added |
| `.github/workflows/sync-animation-metadata.yml` | 1 added |
| `docs/asset-pipeline/ANIMATION_METADATA_SYNC.md` | 1 added |
| `README.md`, `CONTRIBUTING.md`, `unity.yml`, `validate_structure.py` | 4 modified |

## Validation

* **74 / 74 matched** by exact file name across `Combat/`, `Crouch/`, `Death/`,
  `Movement/`, `Weapon/`; no unmatched source file, no ambiguous name.
* **All 74 `.fbx` files byte-identical** (SHA-256 before and after; `git diff`
  shows no model change).
* **The 2 FBX files without source metadata are untouched** —
  `Assets/Characters/{Female/Female,Male/Male} character.fbx`.
* **79 asset GUIDs, all unique** — independently confirmed by
  `processing/unity/validate_csharp.py`.
* **Idempotent** — a rerun reports 74 unchanged and makes no commit.
* `validate_structure.py` 17/17, `validate_csharp.py` 36/36, new sync tests
  26/26.

## The workflow

`workflow_dispatch` + daily `schedule` → anonymous clone of the public source →
unit tests → **pre-flight GUID check (dry run)** → apply → verify → model-touch
check → commit to `chore/sync-animation-metadata` → open **or refresh** the PR.

* Uses the repository `GITHUB_TOKEN` with `contents: write` and
  `pull-requests: write` only.
* Never pushes to `main`; fast-forward only, never a force push.
* Never adds, modifies, renames or deletes an `.fbx`.
* Preserves the committed GUID when the source importer settings change.
* Refuses to write when two assets share a GUID.
* Never overwrites metadata it did not create; reports a local edit as skipped.
* Reuses the open PR for the sync branch instead of opening a second one.

First `workflow_dispatch` run is expected to report "already in sync" with no PR —
that is the idempotence check. `force: true` exercises the PR path.

See `docs/asset-pipeline/ANIMATION_METADATA_SYNC.md` for the full contract.
