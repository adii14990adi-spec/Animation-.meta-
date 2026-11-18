# Apply result — blocked on GitHub App installation scope

Date: 2026-11-18
Patch applied: `0001-animation-metadata-sync.patch`
Patch SHA-256: `49fe4b7ad7cf0aa7fcc94be3ff75e4293ce3f3c3f280a6b0ea1b87a02a2c66ae`

## Done locally (tasks 1–7): everything verified

| Task | Result |
| --- | --- |
| 1. Locate handoff branch | `arena/09d47584-animation-meta` in `Animation-.meta-` |
| 2. Fetch patch + docs from GitHub | all three files retrieved via the contents API |
| 3. Clone target | base `06d5a42` (`main`, unchanged) |
| 4. Create `chore/sync-animation-metadata` | created from `main` |
| 5. `git am --keep-cr` | applied cleanly (whitespace warnings are Unity's own trailing spaces in `motionNodeName: `, kept byte-for-byte) |
| 6. Validators + sync tests | see table below |
| 7. Verification | see table below |
| 8. Push branch | **403 — blocked, permission missing** |
| 9. Open PR | **403 — blocked, permission missing** |
| 10. PR body | `pr-body.md`, ready to reuse unchanged |

### Task 6 — validators

| Check | Result |
| --- | --- |
| `processing/unity/validate_structure.py` | 17 passed, 0 failed |
| `processing/unity/validate_csharp.py` | 36 passed, 0 failed |
| `processing/blender/tests` | 13 tests, OK |
| **`processing/animation-metadata/tests` (new)** | **26 tests, OK** |
| all five workflows parse as YAML | OK |

`validate_unity_map.py` is not listed because its three texture/hash checks cannot
pass in a sandbox without the Git LFS objects (the `.png`/`.bytes` payloads
check out as 131-byte LFS pointers). That failure is identical on unmodified
`main` and is unrelated to this patch; it passes in CI where `lfs: true` fetches
the objects.

### Task 7 — verification

| Requirement | Result |
| --- | --- |
| 74 matching `.fbx.meta` files | **74** metadata files, 74 FBX files, **74/74 paired**, 0 unpaired either way, 74/74 source metas covered |
| Original FBX byte-identical | 76 FBX files compared by SHA-256 against the base commit: **76 identical, 0 changed**; `git diff -- '*.fbx'` empty |
| GUID uniqueness | 79 `.meta` files in `Assets/`, **79 distinct GUIDs, 0 duplicates** (74 under `Assets/Animations/`); confirmed independently by `validate_csharp.py` → "79 asset GUID(s), all unique" |
| No unrelated files changed | 83 files: 74 `.fbx.meta` + 9 tooling/docs/CI. **0** non-metadata files under `unity-project/`, **0** `.fbx` touched. The 2 character FBX files with no source metadata are untouched. |

## Blocked (tasks 8–9): the permission that must be granted

The session's token is a **GitHub App installation token** (`arena…` prefix, no
OAuth scopes, expires on a schedule) — not a personal access token. The Arena
GitHub App is **installed on `Animation-.meta-` only**; it has no installation on
`Battle-royal-indian-edition-`. GitHub installation tokens can only reach
repositories the App installation covers, which is exactly what the evidence
shows.

### Evidence

| Operation on the target repository | Result |
| --- | --- |
| `git clone` / read | **OK** (public repository) |
| `git push` a new branch | `403 Permission to … denied to adii14990adi-spec` |
| `POST /repos/…/git/refs` (REST) | `403 Resource not accessible by integration` |
| `createPullRequest` (GraphQL) | `403 Resource not accessible by integration` |
| `POST /repos/…/forks` | `403 Resource not accessible by integration` |
| `GET /installation/repositories` | `403 Resource not accessible by integration` |
| **Control:** same token, `git push` to `Animation-.meta-` | **OK — new branch created** |

The control push is the decisive test: the credential and its git configuration
are fine, so this is repository scope, not a bad token.

Note that `GET /repos/…/Battle-royal-indian-edition-` still reports
`"permissions": {"push": true, "admin": true}`. That field is computed from the
public repository's relationship to the *user* the App token acts as, not from
the App's installation, so it is misleading here and contradicted by every write
attempt above.

### What to grant

Arena GitHub App installation on the target repository, with write access.
Either:

1. **Recommended** — extend the existing Arena GitHub App installation to include
   `adii14990adi-spec/Battle-royal-indian-edition-`
   (GitHub → Settings → Applications → Arena → Configure → Repository access →
   *Selected repositories* → add it), then reconnect GitHub in Arena so the
   session picks up a new installation token. The App needs:

   | Permission | Level | Why |
   | --- | --- | --- |
   | **Contents** | **Read and write** | create `chore/sync-animation-metadata`, push the commit |
   | **Pull requests** | **Read and write** | open and update the PR |

   `Metadata: read` comes with every installation. Nothing else is required —
   no Actions, Issues, Workflows or Administration permission.

2. **Alternative** — apply the patch with a credential you control (see
   "Apply it" in `README.md`); no App change needed.

If instead a personal access token is preferred, a **fine-grained PAT** scoped to
just this repository with *Contents: Read and write* and *Pull requests: Read and
write* is sufficient. The repository is public, but `workflows` scope is **not**
needed to push a new branch containing a new workflow file — creating the branch
and PR is what matters here.

Also confirm the repository allows the App to push branches: the default branch
must stay protected against direct pushes (this task requires that anyway), and
"Allow GitHub Actions / Apps to create pull requests" should be on.

## To finish once access is granted

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

The result is byte-identical to what was verified above. Nothing was merged,
`main` was never pushed to, and no force mode was used at any point.
