# Final Review — PR #4

**Branch:** `arena/29060efb-animation-meta` · **Commit:** `b4531ce` · **PR #4:** OPEN, **unmerged**
**Review round:** 2 (after implementing all three recommended changes)
**Date:** 2026-11-18

---

## Status of the three requested changes

| # | Change | Status | Evidence |
|---|---|---|---|
| 1 | FBXLoader footer-tolerance fix + regression tests, 74/74 parse | ✅ **Done** | §1, §7 |
| 2 | First Test auto-discovers, analyses, previews — no silent no-op | ✅ **Done** | §2 |
| 3 | `pull_request` CI workflow | ✅ **Done, running** | §3 |
| — | Preserve click-to-auto-analyse (dd83dc4) | ✅ Preserved | §8 |
| — | Preserve Phase 1 | ✅ Verified | §6 |
| — | 74 FBX + 74 `.meta` unmodified | ✅ Verified | §6 |
| — | Male + Female retarget re-tested | ✅ Verified | §4 |
| — | Android Chrome responsive re-verified | ✅ Verified | §5 |
| — | PR #4 kept open and unmerged | ✅ Unmerged | — |

**Plus one extra bug found and fixed during verification** — see §9.

---

## 1. Change 1 — footer-tolerant loading: all 74 animations parse

### The bug (recap, now proven a second way)

`FBXLoader`'s `BinaryParser.endOfContent()` compares the read offset against a
**hardcoded 176-byte** footer budget. Two assets carry **177** trailing bytes,
so the check fails, the parser walks into the footer, and throws
`Unknown property type` with an *empty* type character.

| asset | node tree ends | trailing bytes | stock 176 budget |
|---|---|---|---|
| `idle.fbx` | 427,423 | 162 | passes |
| `walk forward.fbx` | 343,363 | 174 | passes |
| `death from the back.fbx` | 554,160 | **177** | **fails** |
| `reloading.fbx` | 639,136 | **177** | **fails** |

### The fix — `inspector/src/engine/fbxLoaderTolerant.ts`

**Why not patch `node_modules`:** `inspector/node_modules/` is in `.gitignore`
(verified), so a dependency patch would disappear on every `npm ci` and would
never exist in CI. The fix had to live in tracked source.

The module walks only the **top-level** node headers (cheap; never inspects
interior data) to find where the node tree truly ends, then trims
purely-trailing footer bytes so the stock `endOfContent()` fires at that
boundary. Three properties make it safe:

- **Non-destructive** — never mutates the caller's buffer; copies only when a
  trim is needed. The files on disk are never touched.
- **No-op for healthy files** — if the stock budget already passes, the *same*
  `ArrayBuffer` object is returned, so the other 72 assets parse with
  byte-identical input.
- **Fails closed** — if the boundary can't be determined, or the trailing bytes
  don't look like a footer, the original buffer goes to three.js and it throws
  exactly as before. A truncated file is still rejected (tested).

Wired into both call sites: `engine/fbxSkeleton.ts` (pipeline) and
`Phase2App.tsx` (preview). The pipeline records a self-explaining warning:
`FBX footer tolerance applied: trimmed 1 trailing byte(s) …`

### Results

| Metric | Before | After |
|---|---|---|
| Assets parsed | 72 / 74 | **74 / 74** |
| Pipeline failures | 2 | **0** |
| Library "failed" pills | 2 | **0** |
| `death from the back.fbx` preview | ✗ throws | ✅ 179 frames @ 60fps |
| `reloading.fbx` preview | ✗ throws | ✅ 199 frames @ 60fps |

Both recovered assets render with full 65-bone skeletons and complete clips
(2.967 s and 3.300 s), verified in a real browser.

### Regression tests — `tests/phase2.fbxTolerance.test.ts` (11 tests)

- stock loader rejects exactly the two oversized-footer assets, and accepts the controls
- the footer is detected (trailing > 176) rather than the payload being blamed
- **byte-for-byte no-op** for assets that already parse (same object identity, contents unchanged)
- **never mutates** the caller buffer when it does trim
- both rejected assets parse into 65 bones + 53 tracks, exact durations 2.967 s / 3.300 s
- identical bone-name set to a working asset
- **every one of the 74 animations parses**
- **pipeline produces 0 `PROCESSING_FAILED`** for all 74, and the two recovered files carry a real skeleton
- fails closed on a truncated buffer
- non-FBX input is left to three.js to reject
- asset files on disk are unchanged after parsing

**96 tests pass across 8 files** (was 84 across 7).

---

## 2. Change 2 — First Test is no longer a silent no-op

Previously: `if (!discovery) return;` → pressing **🧪 First test** before
**Discover animations** did *nothing at all*, with no feedback.

It now drives the whole sequence itself and reports every stage:

1. **waits for character rigs** (up to 30 s) instead of failing instantly
2. **discovers** animations if not already done
3. **selects** a suitable Idle/Walk via `selectFirstTestAnimation`
4. **analyses** that one asset for **both** characters
5. **builds** the retarget preview

Observed live from a cold page load (no prior discovery), desktop:

```
⏳ First test — discovering animations…
⏳ First test — analysing the clip…
⏳ First test — building the retarget preview…
✅ First test complete — preview is ready. Use “Analyse all animations” to score the whole library.
```

Result: `idle (retargeted) · 64 frames @ 30fps · in-place`, error banner = none.

Failures are now explicit in a dedicated `data-testid="first-test-error"` banner
(e.g. *"Character rigs did not finish loading within 30 s"*). During development
this caught two genuine issues:

- a **stale-closure bug**: `runAnalysis` read `maleRig`/`femaleRig` from a closure
  where they were still `null` even after `runFirstTest` had awaited them. Fixed by
  reading from `rigsRef`, and `runAnalysis` now re-throws so callers can report failure.
- a **startup race**: clicking immediately after load failed with "rigs still
  loading". Now it waits.

The other callers of `runAnalysis` (Analyse all, Retry failed, click-to-analyse)
are guarded so the new re-throw cannot produce unhandled rejections.

---

## 3. Change 3 — PR verification workflow

`.github/workflows/pr-verify.yml`, triggered on `pull_request` (and `push` to
`main`, and `workflow_dispatch`). Previously **no** workflow in this repo
triggered on `pull_request`, so no PR had ever been machine-verified.

Steps: `npm ci` → `tsc -b` → `vitest run --reporter=verbose` → `npm run build`
→ assert both entry points emitted → Phase 1 regression → asset integrity.

Notable checks:

- **Both entry points**: fails if `dist/phase1.html` or `dist/index.html` is missing.
- **Phase 1 regression**: asserts `phase1.html`, `src/main.tsx` and the `phase1`
  input in `vite.config.ts` still exist, that the *"NOT Unity Editor"* disclaimer
  is still present, and that the built `dist/phase1.html` references a bundle.
- **Asset integrity**: verifies all **173** tracked asset files against
  `config/asset-manifest.json` (SHA-256 + size) — **74 `.fbx` + 74 `.fbx.meta`** +
  23 character files — and fails on any hash change.
- **Additions/removals**: compares the tracked file list against the manifest, so
  a PR cannot *add* or *delete* an asset either.
- **PR diff guard**: fails if the PR touches anything under `animations/` or
  `Character/` at all.

The manifest was generated from the current working tree and **every one of the
173 hashes was verified against the pristine baseline commit `558c895`** before
committing it (173/173 match).

Every step was rehearsed locally before pushing: all pass.

**CI result:** see §10.

---

## 4. Male and Female retargeting re-tested

`walk forward.fbx`, desktop and Android, each at four scrub positions:

| Character | Clip label | Distinct rendered frames | Textures |
|---|---|---|---|
| 👨 Male | `walk forward left (retargeted) · 32 frames @ 31fps · in-place` | **4 / 4** | 2 resolved by near-match (`T_Hair_1_Normal_png.png`, `T_Eye_Normal_png.png`) |
| 👩 Female | `walk forward left (retargeted) · 32 frames @ 31fps · in-place` | **4 / 4** | 1 resolved by near-match (`T_Eye_Normal_png.png`) |

Distinctness measured by MD5-hashing the rendered stage at each position, so it
proves the geometry actually changes rather than just the timer.

---

## 5. Android Chrome responsive behaviour re-verified

Pixel 7 profile: `412×915`, DPR 2.625, `isMobile + hasTouch`, Android 13 UA,
`sec-ch-ua-mobile: ?1`.

| Check | Result |
|---|---|
| Layout, initial | `scrollWidth 412 === clientWidth 412` ✅ |
| Layout, after full interaction | `scrollWidth 412 === clientWidth 412` ✅ |
| Horizontal overflow | **none** ✅ |
| Touch scrub (walk, both characters) | max error **0.03** of clip length ✅ |
| Slider reachable | scrolled into view; `y` within `innerHeight` ✅ |
| Playback speed | 0.23 / 0.46 / 0.92 / 1.10 / 1.85 (anim-s per wall-s) ✅ |
| Loop | **2 wraps** ✅ |
| Comparison | **2 cards**, `Same animation evaluated against both characters. walk forward left.fbx` ✅ |
| First Test via touch | completes, 4 stages observed ✅ |
| Console errors | `[]` ✅ |
| Failed requests | `[]` ✅ |

Desktop for comparison: speed 0.23 / 0.47 / 0.94 / 1.48 / 1.87, 1 loop wrap,
0 errors, 0 failed requests.

> **Caveat:** this is Chromium Android *emulation* (touch events, mobile UA,
> layout). There is no physical Android device or emulator in this environment,
> so real mobile GPU/compositing performance is not measured.

---

## 6. Phase 1 and asset integrity

| Check | Result |
|---|---|
| `.fbx` files | **74** |
| `.fbx.meta` files | **74** |
| SHA-256 of all 173 asset files vs `558c895` baseline | **173/173 identical** |
| `git status -- animations/ Character/` | clean |
| Files staged by the commits touching `animations/` or `Character/` | **0** |
| Phase 1 at `/phase1.html` | ✅ title `Character Skeleton Inspector — Phase 1 (GLTF + BIN)`, `<canvas>` present, 0 console errors |
| Phase 1 disclaimer | ✅ *"⚠️ This is NOT Unity Editor."* |
| Phase 2 at `/` | ✅ |

---

## 7. Report artifacts

All five still download from the browser UI and parse:

| File | Bytes |
|---|---|
| `animation-analysis.json` | 321,394 |
| `character-compatibility.json` | 1,102,966 |
| `bone-mappings.json` | 9,969 |
| `animation-validation-report.json` | 2,897 |
| `animation-summary-<stamp>.html` | 25,619 |

Validation report totals now read:

```json
{ "discovered": 74, "processed": 74, "parsedOk": 74, "failed": 0,
  "maleReports": 74, "femaleReports": 74 }
```

All nine integrity checks pass;
`integrity.source_assets_unchanged` / `tests.phase1` / `tests.phase2` are `null`
in the browser export because they are supplied by the caller (they are `true`
in the CI-generated report path).

---

## 8. Preserved: click-to-auto-analyse

The `dd83dc4` behaviour is intact: selecting an animation that has not been
analysed analyses that single asset on demand instead of doing nothing. Verified
on both platforms — clicking an un-analysed item loads its retargeted clip in ~1 s.

---

## 9. Bug found during this round (fixed)

**Changing playback speed or loop restarted the animation from 0.**
`AnimationPreview`'s setup effect depended on `[clip, loop, speed]` but called
`action.reset()`, so every speed change reset the timeline. Measured rate for
`1×` was 0.71 and `2×` 0.88 (should be ~1 and ~2). Loop detection also broke
because the timeline kept restarting.

Fixed: the setup effect now depends on `[clip]` only; dedicated live-update
effects already handle speed and loop. After the fix, rates are monotonic and
correct: **0.23 / 0.47 / 0.94 / 1.48 / 1.87** desktop, **0.23 / 0.46 / 0.92 /
1.10 / 1.85** Android.

This bug was **pre-existing** (present in the previously reviewed commit), not
introduced by these changes.

---

## 10. CI results — PASS

This is the **first time PR #4 has been checked by CI at all**, and it is green.

```
gh pr checks 4
Install, typecheck, test, build, integrity   pass   46s   (run 44317017118)
Analyze FBX, Generate & Validate Unity .meta pass   22s   (run 44317004452)
```

Workflow `PR Verification` → job `Install, typecheck, test, build, integrity`:
**completed / success**. All twelve substantive steps passed:

| Step | Result |
|---|---|
| Checkout (with LFS) | ✅ |
| Setup Node.js 22 | ✅ |
| Install dependencies (clean, lockfile-exact `npm ci`) | ✅ |
| TypeScript check (`tsc -b`) | ✅ |
| Run automated tests (`vitest run`) | ✅ |
| Production build | ✅ |
| Assert both entry points were emitted | ✅ |
| Phase 1 regression (structure of the untouched viewer) | ✅ |
| Original asset integrity (173 tracked asset files) | ✅ |
| No new or removed files in `animations/` or `Character/` | ✅ |
| Asset files were not modified by this PR (git diff vs base) | ✅ |

PR state: **OPEN**, `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`,
head `b4531cea76dc21a25152f4da9c891685f4342611`.

### The integrity gate was itself tested

A check that cannot fail is worthless, so the asset guard was verified to actually
fire:

- tampering one manifest hash → `::error::CHANGED …` → **exit 1** ✅
- appending a single byte to `animations/idle.fbx` → `::error::CHANGED animations/idle.fbx` → **exit 1** ✅
- file then restored and re-verified **byte-identical** to the manifest; `git status` clean ✅

---

## Remaining issues

| Severity | Issue |
|---|---|
| 🟡 | Reports are still git-ignored (`reports/*` in `.gitignore`). If they are deliverables, that rule needs changing. |
| 🟡 | Retarget fidelity is good, not perfect: hands stay at a natural 1.23–1.25 m and match source hips-relative offsets to ~0.15. The forward-left arm pose is faithful to the rifle-carry source, not an artefact. |
| 🟡 | Android verification is emulation only (see §5 caveat). |
| ℹ️ | `generatedAtIso` makes the exported JSON non-reproducible byte-for-byte; the CI integrity check covers source assets, not generated reports. |

---

## Recommended next action

All three requested changes are implemented and verified. **PR #4 remains open
and unmerged, awaiting your approval.**

Suggest reviewing in this order:
1. `inspector/src/engine/fbxLoaderTolerant.ts` — the core fix and its rationale
2. `.github/workflows/pr-verify.yml` + `config/asset-manifest.json` — the CI gate
3. `inspector/src/Phase2App.tsx` — the First Test state machine
4. Confirm the CI run is green on the PR page

Then decide on the `reports/*` gitignore question, and merge when you're satisfied.
