# Animation metadata → Unity project: handoff package

Everything needed to land the animation-metadata sync in
`adii14990adi-spec/Battle-royal-indian-edition-` as **one** reviewable commit.

> **Status (2026-11-18):** the patch has been re-applied on a clean clone of the
> target and all validators and verifications pass. Push and PR creation are
> blocked by GitHub App installation scope — the exact permission to grant is in
> [`APPLY-RESULT.md`](APPLY-RESULT.md).

## Why this is a patch and not a pushed branch

The automation token available to this session can create branches and push to
`adii14990adi-spec/Animation-.meta-` (this repository), but it is **not
installed on** `adii14990adi-spec/Battle-royal-indian-edition-`. Every write path
was tried and is refused:

| Attempt | Result |
| --- | --- |
| `git push` to a new branch | `403 Permission … denied to adii14990adi-spec` |
| `POST /repos/…/git/refs` (REST) | `403 Resource not accessible by integration` |
| `gh api repos/… --jq .permissions` | reports `push: true` — the token's cached metadata is stale, the real grant denies it |

So the change is delivered as a git patch instead. Applying it needs no tools
beyond `git`, and it replays byte-for-byte in a clean clone (verified below).

## Apply it

```bash
git clone https://github.com/adii14990adi-spec/Battle-royal-indian-edition-.git
cd Battle-royal-indian-edition-

git checkout -b chore/sync-animation-metadata
git am --keep-cr ../0001-animation-metadata-sync.patch
git push origin chore/sync-animation-metadata

gh pr create --base main --head chore/sync-animation-metadata \
  --title "chore(animations): sync Unity metadata for the Mixamo FBX library" \
  --body-file ../pr-body.md
```

`git apply --stat ../0001-animation-metadata-sync.patch` previews it first.
`--keep-cr` is only needed if your clone has `core.autocrlf` enabled.

## What the commit contains

| Group | Files |
| --- | ---: |
| `unity-project/Assets/Animations/**/*.fbx.meta` | **74 added** |
| `processing/animation-metadata/sync_animation_meta.py` | 1 added |
| `processing/animation-metadata/tests/test_sync_animation_meta.py` (26 tests) | 1 added |
| `processing/animation-metadata/sync-manifest.json` | 1 added |
| `.github/workflows/sync-animation-metadata.yml` | 1 added |
| `docs/asset-pipeline/ANIMATION_METADATA_SYNC.md` | 1 added |
| `README.md`, `CONTRIBUTING.md`, `.github/workflows/unity.yml`, `processing/unity/validate_structure.py` | 4 modified |
| **`.fbx` files added, modified, renamed or deleted** | **0** |

No unrelated Unity file is touched: the four edits are an added test step, an
added doc requirement, and two documentation links.

## Validation performed

Against the real repositories (74 source `.fbx.meta` files, 74 target `.fbx`):

* **74 / 74 matched by exact file name** across `Combat/`, `Crouch/`, `Death/`,
  `Movement/`, `Weapon/`. Zero unmatched source files. Zero ambiguous names.
* **All 74 FBX files remain byte-identical** — SHA-256 compared before/after;
  `git diff` reports no `.fbx` change; the sync script fails by design if one
  changes.
* **The 2 FBX files with no source metadata** are untouched and reported:
  `Assets/Characters/Female/Female character.fbx`,
  `Assets/Characters/Male/Male character.fbx`.
* **GUIDs** — 74 source GUIDs are unique, none collides with the 5 pre-existing
  asset GUIDs. After the sync the project has **79 asset GUIDs, all unique**
  (independently confirmed by the repository's own
  `processing/unity/validate_csharp.py`).
* **Idempotent** — a second run reports 74 unchanged, 0 added, 0 updated, and
  makes no commit.
* **Repo validators** — `validate_structure.py` 17/17,
  `validate_csharp.py` 36/36, `validate_unity_map.py` 23 passed /
  3 failed, and those 3 failures are pre-existing on `main` in this sandbox
  because the Git LFS objects for the island textures were not fetched here
  (`water_normal_256.png` is a 131-byte LFS pointer). They are unrelated.
* **All five workflows parse** as YAML, and the new workflow's shell steps were
  executed locally against the real data.

## Testing the workflow

After the commit is on `main` (the workflow file must exist on the default
branch before `workflow_dispatch` can see it):

```bash
gh workflow run sync-animation-metadata.yml \
  --repo adii14990adi-spec/Battle-royal-indian-edition-
```

Expected result on the first run: **no changes, no pull request** — the metadata
is already in sync, so the job ends "the project is already in sync" with the
report showing 74 unchanged. That is the idempotence check working. To exercise
the PR path, run with `force: true`, which re-applies the source importer
settings and opens (or refreshes) the pull request on
`chore/sync-animation-metadata`. `check_only: true` verifies without writing.

## Design notes a reviewer should know

* **GUIDs are preserved, not replaced.** If the source repository regenerated a
  GUID for a clip, the GUID already committed here wins and only the rest of the
  `.meta` is updated, so scene and prefab references keep resolving. Replacing a
  GUID would silently break every reference to the clip.
* **Metadata the sync did not write is never overwritten.** The manifest records
  exactly which files this tool owns.
* **A local hand-edit is not reverted** while the source file is unchanged; the
  run reports it as skipped instead. `force: true` is the deliberate override.
* **Root-motion keys.** The source metadata expresses "bake into pose" with
  `keepOriginalOrientation/PositionY/PositionXZ: 1` and leaves the `lockRoot*`
  keys at Unity's default, while the project's `MixamoImportSettings` audit
  compares `lockRoot*`. Both describe the same behaviour; the existing
  `MixamoAnimationImportService.Repair` writes the explicit keys on the next
  editor import, which is idempotent and keeps the `ProjectValidator` gate green.
  The two C# rules stay in place and are the reason a mismatch is still caught.
* **`EXPECTED_META_COUNT: '74'`** in the workflow's `env` is the promised total.
  When the library grows, bump that number in the same PR that adds the FBX.
