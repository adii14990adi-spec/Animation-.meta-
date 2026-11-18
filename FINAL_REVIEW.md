# Final Independent Review — PR #4

**Branch:** `arena/29060efb-animation-meta` · **Commit:** `dd83dc4` · **PR #4:** OPEN, **unmerged**
**Date:** 2026-11-18 · Reviewer: independent verification pass

---

## Verdict

**Phase 2 is functionally correct and safe to merge, with three caveats** (one fixed during this
review, two needing your decision). The most important finding is that **the two "corrupted" FBX
files are not corrupted** — three.js rejects them due to an off-by-one in its own trailer
detection, not because of bad data.

---

## 1. GitHub Actions / CI

**Result: NOT APPLICABLE — and this is a real gap, not a pass.**

```
$ gh pr checks 4
no checks reported on the 'arena/29060efb-animation-meta' branch
```

Root cause — **neither workflow triggers on pull requests**:

| Workflow | Triggers | Runs on PR? |
|---|---|---|
| `deploy-character-inspector.yml` | `push` → `main` only; `workflow_dispatch` | ❌ |
| `generate-animation-meta.yml` | `push` filtered to `animations/**`, `config/*.json`; `workflow_dispatch` | ❌ |

```
$ grep -l "pull_request" .github/workflows/*.yml
NONE — no workflow triggers on pull_request
```

**Nothing has ever been validated by CI on this branch.** Pre-existing runs on `main` include
failures (`44252932401`, `44247092721`, `44246891680`) unrelated to Phase 2. Two recent `main`
runs did succeed.

I therefore re-ran the CI-equivalent suite locally from a **clean `npm ci`** against the committed
tree:

```
npx tsc -b        → clean
npx vitest run    → 7 files, 84 tests, 84 passed
npm run build     → ✓ built in 717ms
```

**Recommended:** add a `pull_request`-triggered workflow running `npm ci && npx tsc -b && npx vitest run && npm run build`. Until then, no PR in this repo has machine-verified status.

---

## 2. `walk forward.fbx` playback — Male and Female

**Result: PASS.** Verified in a real Chromium (131) against the dev server, reading back the
transport timer and hashing stage screenshots at each scrub position.

| Character | Clip label | Scrub positions | Distinct rendered frames |
|---|---|---|---|
| 👨 Male | `walk forward left (retargeted) · 32 frames @ 31fps · in-place` | 0.00 / 0.24 / 0.50 / 0.76 / 1.00 s (of 1.00 s) | **4 / 5** (first and last are the loop point) |
| 👩 Female | `walk forward left (retargeted) · 32 frames @ 31fps · in-place` | 0.00 / 0.50 / 0.00 s (of 1.00 s) | **2 / 3** |

Textures confirmed in-browser:
- Male: `✅ Textures loaded (2 resolved by near-match: T_Hair_1_Normal_png.png, T_Eye_Normal_png.png)`
- Female: `✅ Textures loaded (1 resolved by near-match: T_Eye_Normal_png.png)`

Screenshots: `/tmp/browsertest/walk-male-{0,25,50,75}.png`, `walk-female-{0,50}.png`,
plus Android exports `and2-{male,female}-{0,30,60,90}.png`.

> **Note on `idle.fbx`:** do not judge motion with it — the source clip is genuinely near-static
> (<1 cm hand travel over 2.1 s). That is a property of the asset, not the retargeter.

---

## 3. Scrubbing / looping / speed / comparison on Android Chrome

**Result: PASS** on a Pixel 7 profile (`412×915`, DPR 2.625, `isMobile + hasTouch`, Android 13 UA,
`sec-ch-ua-mobile: ?1`).

| Control | Measured | Verdict |
|---|---|---|
| **Touch scrub** | tap → error ≤ **0.024** of clip length (0.2/0.5/0.8 → 0.24/1.05/1.72 of 2.1 s) | ✅ |
| **Touch drag** | dragged to 75 % → landed at **0.767** | ✅ |
| **Play / pause** | advanced `0.52s → 1.45s`; pause held `1.60s` across 600 ms | ✅ |
| **Speed** | 0.25×→**0.24**, 0.5×→**0.47**, 1×→**0.94**, 1.5×→**1.42**, 2×→**1.87** (anim-s/wall-s) | ✅ |
| **Loop** | 4 wraps across ~4 s of sampling at 2.1 s clip length | ✅ |
| **Comparison** | 2 cards, `Same animation evaluated against both characters. walk forward left.fbx` | ✅ |
| **Layout** | `scrollWidth === clientWidth === 412` before **and** after interaction | ✅ no overflow |
| **Errors** | console `[]`, network `[]` | ✅ |

Desktop equals or beats these numbers (speed 0.26/0.48/1.00/1.50/1.99; mouse scrub error ≤0.01;
1 clean loop wrap).

> **Important caveat about my own first Android run:** it reported scrub error 0.95 and 2× speed
> doing nothing. **Both were false alarms caused by my test harness**, not the app — the transport
> sat at `y=1176` inside a `915px` viewport, so I was tapping outside the viewport and the page was
> still mid-layout. After scrolling the slider into view, every control passed. I am reporting this
> because it is exactly the kind of measurement error that gets mistaken for a product bug.

There is **no real Android device or emulator** in this environment. This is Chromium Android
*emulation*, which exercises touch events, mobile UA and layout — but not real GPU/mobile
compositing performance.

---

## 4. The two failed FBX files — independent investigation

**Result: THE FILES ARE VALID. "Corrupted" was the wrong label — I am retracting it.**

Files: `death from the back.fbx` (554,337 B), `reloading.fbx` (639,313 B).

### Evidence

**(a) Both have valid FBX binary headers** — `Kaydara FBX Binary  \0\x1a\0`, version `7700`.

**(b) An independent parser I wrote from the FBX binary spec (`/tmp/fbxparse.py`) reads them
end-to-end with ZERO structural errors:**

| File | Nodes | Max depth | Sections | Unknown property types | Offset mismatches |
|---|---|---|---|---|---|
| `death from the back.fbx` | 4,197 | 4 | Objects, Connections, Takes, Definitions, GlobalSettings | **0** | **0** |
| `reloading.fbx` | 4,201 | 4 | Objects, Connections, Takes, Definitions, GlobalSettings | **0** | **0** |

**(c) Their animation payloads are complete — identical in structure to files that load fine:**

| File | Model | AnimationStack | AnimationCurve | AnimationCurveNode | Key arrays |
|---|---|---|---|---|---|
| `idle.fbx` (works) | 65 | 1 | 315 | 54 | 630 |
| `walk forward.fbx` (works) | 65 | 1 | 315 | 54 | 630 |
| `death from the back.fbx` (fails) | **65** | **1** | **315** | **54** | **630** |
| `reloading.fbx` (fails) | **65** | **1** | **315** | **54** | **630** |

**(d) Root cause is an off-by-one in three.js's `endOfContent()`, not the data.**
`FBXLoader.js:3494` hardcodes:

```js
return reader.getOffset() + 160 + 16 >= reader.size();   // literal 176
```

These two files carry **177** trailing bytes after the last node, not ≤176:

| File | size % 16 | content end | trailing bytes | three.js thinks at end? |
|---|---|---|---|---|
| `idle.fbx` | 1 | 427,423 | 162 | ✅ yes → parses |
| `walk forward.fbx` | 1 | 343,363 | 174 | ✅ yes → parses |
| `death from the back.fbx` | 1 | 554,160 | **177** | ❌ no → parses footer as a node |
| `reloading.fbx` | 1 | 639,136 | **177** | ❌ no → parses footer as a node |

Hence `THREE.FBXLoader: Unknown property type` with an empty type char — it is reading past the
node tree into the footer. Instrumented loader confirmed the throw at offsets 554,186 / 639,162,
exactly 151 bytes before EOF in both.

**(e) Proof:** widening the tolerance from 176 → 256 bytes makes **both files load perfectly**:

```
OK   death from the back.fbx :: bones=65 clips=1 dur=2.967s tracks=53
OK   reloading.fbx           :: bones=65 clips=1 dur=3.300s tracks=53
OK   idle.fbx                :: bones=65 clips=1 dur=2.100s tracks=53
OK   walk forward.fbx        :: bones=65 clips=1 dur=1.000s tracks=53
```

Full skeletons, complete clips. **These are good assets that the loader rejects.**

### Recommendation

Do **not** call these corrupted in reports, docs, or the UI. Options, in order of preference:

1. **Widen the trailer tolerance** in a small `FBXLoader` patch (upstream-friendly) → 74/74 parse.
2. Keep them as `PROCESSING_FAILED` but relabel the reason as
   *"rejected by the FBX loader (trailer/EOF detection), payload appears intact"*.
3. Leave as-is if scope forbids loader changes — but fix the wording.

I did **not** ship a loader patch: `node_modules` is not vendored and patching a dependency is a
scope decision for you. The vendored loader was restored after testing and the app behaves as before.

---

## 5. All five report artifacts downloadable from the browser UI

**Result: PASS.** Clicking **⬇️ Export reports** in a real browser downloaded exactly five files,
each of which parses:

| File | Bytes | Validation |
|---|---|---|
| `animation-analysis.json` | 313,666 | ✅ valid JSON — `schemaVersion, report, generatedAtIso, discovery, assets, limitations` |
| `character-compatibility.json` | 1,081,232 | ✅ valid JSON |
| `bone-mappings.json` | 9,981 | ✅ valid JSON |
| `animation-validation-report.json` | 3,155 | ✅ valid JSON — `checks` (9), `totals` |
| `animation-summary-<stamp>.html` | 25,897 | ✅ valid HTML, contains "Limitations", "Not Unity"/"AvatarBuilder", "74" |

---

## 6. Phase 1 + asset integrity

**Result: PASS — nothing touched.**

| Check | Result |
|---|---|
| `.fbx` files | **74** |
| `.fbx.meta` files | **74** |
| `git diff origin/main -- animations/ Character/` | **empty** (identical to `main`) |
| `git status -- animations/ Character/` | clean |
| Character bundles | `Male` 11 files, `Female` 11 files, unchanged |
| Phase 1 at `/phase1.html` | ✅ renders, `<canvas>` present, 0 console errors |
| Phase 1 title | `Character Skeleton Inspector — Phase 1 (GLTF + BIN)` |
| Phase 1 disclaimer intact | "⚠️ This is NOT Unity Editor." |
| Phase 2 at `/` | ✅ |

---

## 7. Remaining issues

### 🔴 Found and FIXED during this review — silent dead click

Clicking any animation *before* running **Analyse all** did **nothing**: the retarget effect bailed
out on `mapping.length === 0` without setting state, so the preview kept reading *"Character ready —
pick an animation."* Reproduced on **both** desktop and Android.

**Fixed in `dd83dc4`.** Selecting an un-analysed asset now analyses that single asset on demand.
Verified after fix, both platforms:

```
desktop: pillBefore "not analysed" → previewLoaded true in 1000ms
         → "Crouch Walking (retargeted) · 37 frames @ 31fps · in-place"
android: pillBefore "not analysed" → previewLoaded true in 1000ms  (same clip)
```

### 🟠 Needs your decision — "First test" is also a silent no-op before Discovery

`🧪 First test (1 Idle/Walk)` does nothing if Discovery has not run. It cannot obviously
self-discover (discovery may itself be async/slow), so this needs a product call:
**disable the button until discovery completes**, or **auto-discover on click**.
I deliberately did not guess. Evidence: `rate.js` run 1 and 2 timed out at the same wait because of this.

### 🟠 Needs your decision — the loader patch (see §4)

Fix the trailer tolerance (74/74 usable) or keep 72/74 with corrected wording. Currently billed as
"malformed", which is inaccurate.

### 🟡 No PR CI (see §1)

### 🟡 Report artifacts are gitignored

`.gitignore` line 16 has `reports/*` with the comment *"transient reports (never commit temporary
files)"*, and `reports/.gitkeep` is tracked. I regenerated all five into `reports/` locally but they
**do not appear in the PR**. If they are intended deliverables, that ignore rule needs changing.

### 🟡 Retarget fidelity is good, not perfect

The world-space transfer keeps hands at a natural 1.23–1.25 m and matches source hips-relative
hand offsets to ~0.15 (vs ~1.2 for the previously shipped local-frame form). Hands still cross
slightly forward-left — that is faithful to the source rifle-carry pose, confirmed by measuring the
source animation itself. Residual ~0.15 error is proportion differences between Mixamo and the
Unreal-style rig; acceptable for preview, not a claim of engine-grade retargeting.

---

## Recommended next action

**Do not merge yet.** Ship `dd83dc4` for review, then:

1. **Decide the loader question (§4)** — highest value. A ~1-line tolerance change turns 72/74 into
   74/74 and removes a misleading "corrupted" label from the product.
2. **Decide "First test" behaviour** — disable vs auto-discover.
3. **Add a `pull_request` CI workflow** so PRs stop being unverified.
4. Then merge PR #4.

Everything else is verified green: 84/84 tests, clean `tsc` + build from a fresh `npm ci`, 0 console
errors and 0 failed requests on desktop and Android emulation, Phase 1 intact, and all 148 asset
files byte-identical to `main`.
