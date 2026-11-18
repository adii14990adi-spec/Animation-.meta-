#!/usr/bin/env python3
"""Comprehensive Validator for FBX Animation Assets & Unity `.meta` Files.

Validates:
1. Every `.fbx` in `animations/` has a corresponding `.meta` file.
2. Every `.meta` has a valid, non-zero 32-char lowercase hex Unity GUID.
3. All GUIDs across the repository are globally unique.
4. GUIDs remain stable across executions (checked against Git history & cache).
5. `.meta` structure strictly conforms to Unity `ModelImporter` YAML serialization.
6. No orphaned `.meta` files remain after FBX deletion.
7. No conflicting case-insensitive paths, duplicate clip names, or broken PPtr references exist.
8. Every FBX is readable and contains valid animation data (no static character models).
9. Optional Unity Editor batch-mode import validation (clearly separated from static validation).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.analyze_fbx import analyze_fbx_file
from scripts.unity_batch_validate import run_optional_unity_batch_validation
from scripts.utils import (
    EXCLUDED_SCAN_DIRS,
    VALID_BODY_MASK_RE,
    AssetCache,
    UnityMetaParseError,
    atomic_write_text,
    compute_sha256,
    discover_fbx_files,
    discover_meta_files,
    fbx_path_for_meta,
    is_fbx_file,
    is_fbx_meta_file,
    is_unity_pptr_dict,
    is_valid_unity_guid,
    list_git_meta_guids_at_ref,
    load_json_config,
    load_unity_meta,
    meta_path_for_fbx,
    normalize_rel_path,
    normalize_unicode,
    scan_repository_guids,
    write_json_report,
)


def _validate_pptr(pptr: Any, require_external_guid: bool = False) -> tuple[bool, str]:
    if not isinstance(pptr, dict) or not is_unity_pptr_dict(pptr):
        return False, f"Expected Unity Object PPtr mapping ({{instanceID: 0}} or {{fileID, guid, type}}), got {pptr!r}"
    if "instanceID" in pptr:
        if require_external_guid:
            return False, "Avatar/Mask setup 'CopyFromOther' requires an external GUID reference, got {instanceID: 0}"
        return True, ""
    if "guid" in pptr:
        if not is_valid_unity_guid(pptr["guid"]):
            return False, f"Invalid GUID inside Object PPtr reference: {pptr.get('guid')!r}"
        if not isinstance(pptr.get("type"), int):
            return False, f"Missing or non-integer 'type' inside Object PPtr reference: {pptr!r}"
    elif require_external_guid:
        return False, f"CopyFromOther PPtr missing external 'guid': {pptr!r}"
    return True, ""


def validate_model_importer_structure(
    meta_path: Path,
    meta_rel_path: str,
    *,
    analysis: dict[str, Any] | None = None,
    has_explicit_rig_override: bool = False,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]], list[dict[str, Any]]]:
    """Validate a single `.fbx.meta` file against Unity's actual `ModelImporter` schema.

    Returns `(parsed_meta_or_none, failures, warnings)`.
    """
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    def fail(code: str, msg: str, remediation: str = "") -> None:
        failures.append(
            {
                "code": code,
                "severity": "critical",
                "file": meta_rel_path,
                "message": msg,
                "remediation": remediation,
            }
        )

    def warn(code: str, msg: str) -> None:
        warnings.append(
            {
                "code": code,
                "severity": "warning",
                "file": meta_rel_path,
                "message": msg,
            }
        )

    try:
        raw_text = meta_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        fail(
            "UNREADABLE_META",
            f"Cannot read .meta file as UTF-8 text: {exc}",
            "Regenerate the corrupted .meta file.",
        )
        return None, failures, warnings

    non_empty_lines = [ln.strip() for ln in raw_text.splitlines() if ln.strip()]
    if len(non_empty_lines) < 3 or not non_empty_lines[0].startswith("fileFormatVersion:"):
        fail(
            "INVALID_META_HEADER",
            "Unity .meta file must begin with 'fileFormatVersion: 2' at line 1.",
            "Ensure .meta is serialized in genuine Unity AssetImporter format rather than generic YAML/JSON.",
        )

    try:
        meta = load_unity_meta(meta_path)
    except UnityMetaParseError as exc:
        fail(
            "INVALID_META_SYNTAX",
            str(exc),
            "Fix or regenerate the .meta file using scripts/generate_meta.py.",
        )
        return None, failures, warnings

    if meta.get("fileFormatVersion") != 2:
        fail(
            "INVALID_FILE_FORMAT_VERSION",
            f"Expected fileFormatVersion: 2, got {meta.get('fileFormatVersion')!r}.",
            "Set fileFormatVersion: 2.",
        )

    guid = meta.get("guid")
    if not is_valid_unity_guid(guid):
        fail(
            "INVALID_GUID",
            f"Invalid Unity GUID {guid!r} (must be 32 lowercase hex characters and non-zero).",
            "Assign a valid 32-character lowercase hexadecimal GUID.",
        )

    mi = meta.get("ModelImporter")
    if not isinstance(mi, dict):
        fail(
            "MISSING_MODEL_IMPORTER",
            "Missing top-level 'ModelImporter' mapping required for FBX assets.",
            "Use Unity ModelImporter serialization instead of DefaultImporter or custom keys.",
        )
        return meta, failures, warnings

    sv = mi.get("serializedVersion")
    if not isinstance(sv, int) or sv < 10000:
        fail(
            "INVALID_SERIALIZED_VERSION",
            f"Invalid ModelImporter.serializedVersion: {sv!r} (expected Unity integer version >= 10000).",
            "Use a valid Unity ModelImporter serializedVersion (e.g. 21202 or 22200).",
        )

    if not isinstance(mi.get("internalIDToNameTable"), list):
        fail(
            "INVALID_INTERNAL_ID_TABLE",
            "ModelImporter.internalIDToNameTable must be a list.",
        )

    if not isinstance(mi.get("externalObjects"), (dict, list)):
        fail(
            "INVALID_EXTERNAL_OBJECTS",
            "ModelImporter.externalObjects must be a mapping ({}) or list of SourceAssetIdentifier pairs.",
        )

    # Validate materials block
    mats = mi.get("materials")
    if not isinstance(mats, dict) or mats.get("materialImportMode") not in (0, 1, 2):
        fail(
            "INVALID_MATERIALS_SECTION",
            "ModelImporter.materials is missing or has an invalid materialImportMode.",
        )

    # Validate meshes block
    meshes = mi.get("meshes")
    if not isinstance(meshes, dict):
        fail("MISSING_MESHES_SECTION", "ModelImporter.meshes mapping is missing.")
    else:
        gscale = meshes.get("globalScale")
        if not isinstance(gscale, (int, float)) or gscale <= 0:
            fail(
                "INVALID_GLOBAL_SCALE",
                f"ModelImporter.meshes.globalScale must be > 0, got {gscale!r}.",
            )
        if meshes.get("meshCompression") not in (0, 1, 2, 3):
            fail(
                "INVALID_MESH_COMPRESSION",
                f"ModelImporter.meshes.meshCompression must be in {{0,1,2,3}}, got {meshes.get('meshCompression')!r}.",
            )
        if meshes.get("fileIdsGeneration") not in (0, 1, 2):
            fail(
                "INVALID_FILE_IDS_GENERATION",
                f"ModelImporter.meshes.fileIdsGeneration must be in {{0,1,2}}, got {meshes.get('fileIdsGeneration')!r}.",
            )

    if not isinstance(mi.get("tangentSpace"), dict):
        fail("MISSING_TANGENT_SPACE", "ModelImporter.tangentSpace mapping is missing.")

    # Validate rig & avatar configuration
    anim_type = mi.get("animationType")
    if anim_type not in (0, 1, 2, 3):
        fail(
            "INVALID_ANIMATION_TYPE",
            f"ModelImporter.animationType must be 0 (None), 1 (Legacy), 2 (Generic), or 3 (Humanoid); got {anim_type!r}.",
        )

    avatar_setup = mi.get("avatarSetup")
    if avatar_setup not in (0, 1, 2):
        fail(
            "INVALID_AVATAR_SETUP",
            f"ModelImporter.avatarSetup must be 0 (NoAvatar), 1 (CreateFromThisModel), or 2 (CopyFromOther); got {avatar_setup!r}.",
        )

    ok_av_pptr, av_err = _validate_pptr(
        mi.get("lastHumanDescriptionAvatarSource"),
        require_external_guid=(avatar_setup == 2),
    )
    if not ok_av_pptr:
        fail("INVALID_AVATAR_SOURCE_PPTR", f"ModelImporter.lastHumanDescriptionAvatarSource: {av_err}")

    hd = mi.get("humanDescription")
    if not isinstance(hd, dict) or not isinstance(hd.get("human"), list) or not isinstance(hd.get("skeleton"), list):
        fail(
            "INVALID_HUMAN_DESCRIPTION",
            "ModelImporter.humanDescription must be a mapping containing 'human' and 'skeleton' lists.",
        )

    # Cross-check rig compatibility against analyzed FBX structure
    if analysis and analysis.get("is_valid") and anim_type == 3 and not has_explicit_rig_override:
        detected_rig = analysis.get("rig_classification", {}).get("rig_type")
        if detected_rig != "Humanoid":
            fail(
                "INCOMPATIBLE_HUMANOID_RIG",
                f"Metadata sets animationType=3 (Humanoid), but FBX rig was classified as '{detected_rig}' "
                f"({analysis.get('rig_classification', {}).get('reason', '')}).",
                "Use Generic (animationType=2) or add an explicit rig_type override in config/animation_rules.json if using CopyFromOther avatar.",
            )

    import_anim = mi.get("importAnimation")
    if import_anim not in (0, 1):
        fail(
            "INVALID_IMPORT_ANIMATION_FLAG",
            f"ModelImporter.importAnimation must be 0 or 1, got {import_anim!r}.",
        )
    elif import_anim == 0:
        warn(
            "ANIMATION_IMPORT_DISABLED",
            "ModelImporter.importAnimation is set to 0 (disabled) on an animation FBX asset.",
        )

    # Validate animations & clipAnimations section
    anims = mi.get("animations")
    if not isinstance(anims, dict):
        fail("MISSING_ANIMATIONS_SECTION", "ModelImporter.animations mapping is missing.")
        return meta, failures, warnings

    if anims.get("resampleCurves") not in (0, 1):
        fail(
            "INVALID_RESAMPLE_CURVES",
            f"ModelImporter.animations.resampleCurves must be 0 or 1, got {anims.get('resampleCurves')!r}.",
        )

    if anims.get("animationCompression") not in (0, 1, 2, 3):
        fail(
            "INVALID_ANIMATION_COMPRESSION",
            f"ModelImporter.animations.animationCompression must be in {{0,1,2,3}}, got {anims.get('animationCompression')!r}.",
        )

    clips = anims.get("clipAnimations")
    if not isinstance(clips, list):
        fail("INVALID_CLIP_ANIMATIONS", "ModelImporter.animations.clipAnimations must be a list.")
    else:
        if import_anim == 1 and len(clips) == 0:
            warn(
                "EMPTY_CLIP_ANIMATIONS",
                "clipAnimations is empty; Unity will fall back to default unconfigured FBX takes.",
            )

        seen_clip_names: set[str] = set()
        bool_clip_fields = (
            "loopTime",
            "loopBlend",
            "loopBlendOrientation",
            "loopBlendPositionY",
            "loopBlendPositionXZ",
            "keepOriginalOrientation",
            "keepOriginalPositionY",
            "keepOriginalPositionXZ",
            "heightFromFeet",
            "mirror",
            "hasAdditiveReferencePose",
        )
        for idx, clip in enumerate(clips):
            if not isinstance(clip, dict):
                fail("INVALID_CLIP_ENTRY", f"clipAnimations[{idx}] is not a mapping.")
                continue
            cname = clip.get("name")
            tname = clip.get("takeName")
            if not isinstance(cname, str) or not cname.strip():
                fail("INVALID_CLIP_NAME", f"clipAnimations[{idx}].name must be a non-empty string.")
            elif cname in seen_clip_names:
                fail(
                    "DUPLICATE_CLIP_NAME",
                    f"Duplicate AnimationClip name '{cname}' inside {meta_rel_path}.",
                )
            else:
                seen_clip_names.add(cname)

            if not isinstance(tname, str) or not tname.strip():
                fail("INVALID_TAKE_NAME", f"clipAnimations[{idx}].takeName must be a non-empty string.")

            ff = clip.get("firstFrame")
            lf = clip.get("lastFrame")
            if not isinstance(ff, (int, float)) or not isinstance(lf, (int, float)):
                fail(
                    "INVALID_CLIP_FRAMES",
                    f"clipAnimations[{idx}] firstFrame/lastFrame must be numeric, got {ff!r}..{lf!r}.",
                )
            elif ff > lf:
                fail(
                    "INVERTED_CLIP_FRAME_RANGE",
                    f"clipAnimations[{idx}] ('{cname}') has firstFrame ({ff}) > lastFrame ({lf}).",
                )

            for bf in bool_clip_fields:
                if clip.get(bf) not in (0, 1):
                    fail(
                        "INVALID_CLIP_BOOL_FIELD",
                        f"clipAnimations[{idx}].{bf} must be 0 or 1, got {clip.get(bf)!r}.",
                    )

            bmask = clip.get("bodyMask")
            if not isinstance(bmask, str) or not VALID_BODY_MASK_RE.match(bmask):
                fail(
                    "INVALID_CLIP_BODY_MASK",
                    f"clipAnimations[{idx}].bodyMask must be a 104-char hex byte string (got {type(bmask).__name__}: {str(bmask)[:32]!r}).",
                    "Avoid re-dumping Unity .meta files with naive YAML 1.1 parsers that coerce '01000000...' into octal integers.",
                )

            mtype = clip.get("maskType")
            if mtype not in (0, 1, 3):
                fail(
                    "INVALID_CLIP_MASK_TYPE",
                    f"clipAnimations[{idx}].maskType must be 0, 1, or 3; got {mtype!r}.",
                )
            ok_mask, mask_err = _validate_pptr(
                clip.get("maskSource"), require_external_guid=(mtype == 1)
            )
            if not ok_mask:
                fail("INVALID_CLIP_MASK_SOURCE", f"clipAnimations[{idx}].maskSource: {mask_err}")

    return meta, failures, warnings


def _render_markdown_summary(report: dict[str, Any]) -> str:
    status_badge = "PASSED" if report["passed"] else "FAILED"
    unity_info = report.get("unity_editor_validation", {})
    unity_status = unity_info.get("status", "skipped_unavailable")

    lines = [
        f"# Unity FBX Animation Metadata Validation — {status_badge}",
        "",
        "| Metric | Count |",
        "| :--- | ---: |",
        f"| Total FBX Files | `{report['total_fbx_files']}` |",
        f"| Successfully Analyzed FBX Files | `{report['successfully_analyzed_files']}` |",
        f"| Newly Generated `.meta` Files | `{report['generated_metadata_files']}` |",
        f"| Existing `.meta` Files Preserved | `{report['existing_metadata_files_preserved']}` |",
        f"| Invalid FBX Files | `{report['invalid_fbx_files']}` |",
        f"| Missing `.meta` Files | `{report['missing_metadata_files']}` |",
        f"| Orphaned `.meta` Files | `{report['orphaned_metadata_files']}` |",
        f"| Duplicate GUID Groups | `{report['duplicate_guids']}` |",
        f"| Failed Validation Checks | `{len(report['failed_validation_checks'])}` |",
        f"| Validation Tier | `{report['validation_mode']}` (Unity Batch: `{unity_status}`) |",
        "",
        f"> **Validation Scope Note:** {unity_info.get('static_vs_runtime_note', '')}",
        "",
    ]

    if report["failed_validation_checks"]:
        lines.append("## Critical Validation Failures")
        lines.append("")
        for item in report["failed_validation_checks"]:
            rem = f" — *Remediation:* {item['remediation']}" if item.get("remediation") else ""
            lines.append(f"- **`[{item['code']}]`** `{item.get('file', '<repo>')}`: {item['message']}{rem}")
        lines.append("")

    if report.get("warnings"):
        lines.append("## Warnings")
        lines.append("")
        for w in report["warnings"][:50]:
            lines.append(f"- **`[{w['code']}]`** `{w.get('file', '<repo>')}`: {w['message']}")
        lines.append("")

    return "\n".join(lines) + "\n"


def validate_repository(
    *,
    repo_root: Path | str,
    animations_dir: Path | str | None = None,
    animation_rules_path: Path | str | None = None,
    cache_path: Path | str | None = None,
    reports_dir: Path | str | None = None,
    base_ref: str | None = None,
    unity_editor_path: str | None = None,
    unity_project_path: str | None = None,
    write_reports: bool = True,
) -> dict[str, Any]:
    """Perform full validation of FBX animations and Unity `.meta` files."""
    root = Path(repo_root).resolve()
    anim_dir = Path(animations_dir).resolve() if animations_dir else (root / "animations")
    rules_file = (
        Path(animation_rules_path).resolve()
        if animation_rules_path
        else (root / "config" / "animation_rules.json")
    )
    cache_file = (
        Path(cache_path).resolve()
        if cache_path
        else (root / ".cache" / "fbx_meta_cache.json")
    )
    rep_dir = Path(reports_dir).resolve() if reports_dir else (root / "reports")

    animation_rules = load_json_config(rules_file) if rules_file.exists() else {}
    asset_overrides = animation_rules.get("asset_overrides", {}) if isinstance(animation_rules, dict) else {}

    cache = AssetCache(cache_file)

    failed_checks: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    # Check for non-FBX files inside `animations/` (warn and ignore without modifying unrelated files)
    if anim_dir.exists():
        for cur_root, dirs, files in os.walk(anim_dir):
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_SCAN_DIRS and not d.startswith("."))
            for fname in sorted(files):
                if fname.startswith(".") or fname.endswith(".meta"):
                    continue
                if not fname.lower().endswith(".fbx"):
                    bad_rel = normalize_rel_path(Path(cur_root) / fname, root)
                    warnings.append(
                        {
                            "code": "IGNORED_NON_FBX_FILE",
                            "severity": "warning",
                            "file": bad_rel,
                            "message": (
                                f"Non-FBX file '{bad_rel}' present in animations/ was ignored "
                                "(pipeline only generates .meta for .fbx animation assets)."
                            ),
                        }
                    )

    fbx_files = discover_fbx_files(anim_dir)
    meta_files_in_anim = discover_meta_files(anim_dir)

    # Detect case-insensitive FBX path collisions (breaks Windows/macOS Unity checkouts)
    casefold_map: dict[str, list[str]] = {}
    for fbx_p in fbx_files:
        rel_p = normalize_rel_path(fbx_p, root)
        casefold_map.setdefault(rel_p.lower(), []).append(rel_p)
    for _, colliding in sorted(casefold_map.items()):
        if len(colliding) > 1:
            failed_checks.append(
                {
                    "code": "CASE_COLLISION_CONFLICT",
                    "severity": "critical",
                    "file": colliding[0],
                    "message": f"Case-insensitive asset path conflict detected: {', '.join(colliding)}.",
                    "remediation": "Rename conflicting FBX files so their paths differ case-insensitively.",
                }
            )

    # Analyze all FBX files (using SHA-256 cache for unchanged files)
    analyzed_ok_count = 0
    invalid_fbx_list: list[str] = []
    missing_meta_list: list[str] = []
    valid_meta_count = 0

    for fbx_p in fbx_files:
        rel_p = normalize_rel_path(fbx_p, root)
        meta_p = meta_path_for_fbx(fbx_p)
        meta_rel = normalize_rel_path(meta_p, root)

        cached = cache.get_entry(rel_p)
        analysis: dict[str, Any]
        if (
            cached
            and fbx_p.is_file()
            and fbx_p.stat().st_size > 0
            and cached.get("sha256") == compute_sha256(fbx_p)
            and isinstance(cached.get("analysis"), dict)
        ):
            analysis = cached["analysis"]
        else:
            analysis = analyze_fbx_file(fbx_p, repo_root=root, animation_rules=animation_rules)

        if analysis.get("is_valid"):
            analyzed_ok_count += 1
        else:
            invalid_fbx_list.append(rel_p)
            failed_checks.append(
                {
                    "code": analysis.get("error_code") or "INVALID_FBX",
                    "severity": "critical",
                    "file": rel_p,
                    "message": "; ".join(analysis.get("errors", [])) or "Invalid FBX animation file.",
                    "remediation": "Re-export a valid Binary/ASCII FBX containing animation keyframes.",
                }
            )

        if not meta_p.exists():
            missing_meta_list.append(rel_p)
            failed_checks.append(
                {
                    "code": "MISSING_META",
                    "severity": "critical",
                    "file": rel_p,
                    "message": f"Missing corresponding Unity metadata file '{meta_rel}'.",
                    "remediation": "Run python scripts/generate_meta.py to generate missing .meta files.",
                }
            )
            continue

        has_rig_ov = False
        if isinstance(asset_overrides, dict):
            for k, ov in asset_overrides.items():
                if isinstance(ov, dict) and ("rig_type" in ov or "animation_type" in ov):
                    if k in (rel_p, fbx_p.name):
                        has_rig_ov = True
                        break

        _, m_failures, m_warnings = validate_model_importer_structure(
            meta_p,
            meta_rel,
            analysis=analysis if analysis.get("is_valid") else None,
            has_explicit_rig_override=has_rig_ov,
        )
        failed_checks.extend(m_failures)
        warnings.extend(m_warnings)
        if not m_failures:
            valid_meta_count += 1

    # Detect orphaned `.meta` files inside `animations/`
    orphaned_meta_list: list[str] = []
    for meta_p in meta_files_in_anim:
        meta_rel = normalize_rel_path(meta_p, root)
        target_p = fbx_path_for_meta(meta_p)
        if not target_p.exists():
            orphaned_meta_list.append(meta_rel)
            failed_checks.append(
                {
                    "code": "ORPHANED_META",
                    "severity": "critical",
                    "file": meta_rel,
                    "message": f"Orphaned metadata file '{meta_rel}' has no matching asset '{normalize_rel_path(target_p, root)}'.",
                    "remediation": "Delete the orphaned .meta file or restore its .fbx asset.",
                }
            )
        elif not is_fbx_meta_file(meta_p) and target_p.is_file():
            failed_checks.append(
                {
                    "code": "NON_FBX_META",
                    "severity": "critical",
                    "file": meta_rel,
                    "message": f"Metadata '{meta_rel}' targets a non-FBX file inside animations/.",
                    "remediation": "Keep only FBX animation assets and their .fbx.meta files inside animations/.",
                }
            )

    # Check global GUID uniqueness across the entire repository
    guid_to_paths, path_to_guid = scan_repository_guids(root)
    duplicate_guid_map: dict[str, list[str]] = {
        g: paths for g, paths in sorted(guid_to_paths.items()) if len(paths) > 1
    }
    for dup_guid, conflicting in duplicate_guid_map.items():
        failed_checks.append(
            {
                "code": "DUPLICATE_GUID",
                "severity": "critical",
                "file": ", ".join(conflicting),
                "message": f"Duplicate GUID '{dup_guid}' shared by {len(conflicting)} metadata files: {', '.join(conflicting)}.",
                "remediation": "Restore each asset's original unique GUID; never copy .meta GUIDs across distinct assets.",
            }
        )

    # Check GUID stability against Git reference (base_ref or HEAD) & persistent cache
    anim_rel_dir = normalize_rel_path(anim_dir, root) if anim_dir.is_relative_to(root) else "animations"
    check_ref = base_ref or "HEAD"
    historical_guids = list_git_meta_guids_at_ref(root, check_ref, animations_rel_dir=anim_rel_dir)
    for meta_rel, old_guid in sorted(historical_guids.items()):
        cur_guid = path_to_guid.get(meta_rel)
        if cur_guid is not None and cur_guid != old_guid:
            failed_checks.append(
                {
                    "code": "GUID_INSTABILITY",
                    "severity": "critical",
                    "file": meta_rel,
                    "message": (
                        f"GUID for existing metadata '{meta_rel}' changed from '{old_guid}' "
                        f"(at {check_ref}) to '{cur_guid}'."
                    ),
                    "remediation": f"Restore original GUID '{old_guid}' in '{meta_rel}' to prevent broken Unity references.",
                }
            )

    for rel_fbx, cached_info in sorted(cache.assets.items()):
        meta_rel = f"{normalize_unicode(rel_fbx)}.meta"
        cached_guid = cached_info.get("guid")
        cur_guid = path_to_guid.get(meta_rel)
        if (
            cached_guid
            and cur_guid
            and cached_guid != cur_guid
            and meta_rel not in historical_guids
        ):
            failed_checks.append(
                {
                    "code": "GUID_INSTABILITY",
                    "severity": "critical",
                    "file": meta_rel,
                    "message": (
                        f"GUID for '{meta_rel}' mutated from cached '{cached_guid}' to '{cur_guid}'."
                    ),
                    "remediation": f"Restore GUID '{cached_guid}' in '{meta_rel}'.",
                }
            )

    # Optional Unity Editor Batch-Mode Validation
    unity_result = run_optional_unity_batch_validation(
        repo_root=root,
        fbx_files=fbx_files,
        unity_editor_path=unity_editor_path,
        unity_project_path=unity_project_path,
    )
    if unity_result.get("passed") is False:
        for u_err in unity_result.get("errors", []):
            failed_checks.append(
                {
                    "code": "UNITY_BATCH_VALIDATION_FAILED",
                    "severity": "critical",
                    "file": "<unity-batch>",
                    "message": u_err,
                    "remediation": "Inspect FBX skeleton T-pose/import settings in Unity Editor.",
                }
            )
    for u_warn in unity_result.get("warnings", []):
        warnings.append(
            {
                "code": "UNITY_BATCH_WARNING",
                "severity": "warning",
                "file": "<unity-batch>",
                "message": u_warn,
            }
        )

    # Incorporate generation counts if generation_report.json was produced in this workflow run
    gen_report_path = rep_dir / "generation_report.json"
    generated_count = 0
    preserved_count = valid_meta_count
    if gen_report_path.exists():
        try:
            gen_data = json.loads(gen_report_path.read_text(encoding="utf-8"))
            if isinstance(gen_data, dict):
                generated_count = int(gen_data.get("generated_metadata_files", 0))
                preserved_count = int(
                    gen_data.get("existing_metadata_files_preserved", valid_meta_count)
                )
        except (OSError, ValueError):
            pass

    validation_mode = (
        "static_and_unity_editor" if unity_result.get("executed") else "static_only"
    )
    passed = len(failed_checks) == 0

    validation_report: dict[str, Any] = {
        "schema_version": 1,
        "passed": passed,
        "validation_mode": validation_mode,
        "total_fbx_files": len(fbx_files),
        "successfully_analyzed_files": analyzed_ok_count,
        "generated_metadata_files": generated_count,
        "existing_metadata_files_preserved": preserved_count,
        "invalid_fbx_files": len(invalid_fbx_list),
        "missing_metadata_files": len(missing_meta_list),
        "orphaned_metadata_files": len(orphaned_meta_list),
        "duplicate_guids": len(duplicate_guid_map),
        "invalid_fbx_file_list": invalid_fbx_list,
        "missing_metadata_file_list": missing_meta_list,
        "orphaned_metadata_file_list": orphaned_meta_list,
        "duplicate_guid_map": duplicate_guid_map,
        "failed_validation_checks": failed_checks,
        "warnings": warnings,
        "unity_editor_validation": unity_result,
    }

    if write_reports:
        rep_dir.mkdir(parents=True, exist_ok=True)
        write_json_report(rep_dir / "validation_report.json", validation_report)
        summary_md = _render_markdown_summary(validation_report)
        atomic_write_text(rep_dir / "validation_summary.md", summary_md)

        step_summary_env = os.environ.get("GITHUB_STEP_SUMMARY")
        if step_summary_env:
            try:
                with open(step_summary_env, "a", encoding="utf-8") as sfh:
                    sfh.write(summary_md)
            except OSError:
                pass

    return validation_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate FBX animation assets and their Unity ModelImporter .meta files."
    )
    parser.add_argument("--repo-root", default=".", help="Repository root directory")
    parser.add_argument("--animations-dir", default=None, help="Animations directory (default: <repo>/animations)")
    parser.add_argument("--animation-rules", default=None, help="Path to animation_rules.json")
    parser.add_argument("--cache-path", default=None, help="Path to incremental asset cache JSON")
    parser.add_argument("--reports-dir", default=None, help="Directory for JSON/Markdown reports")
    parser.add_argument("--base-ref", default=None, help="Git base commit SHA/ref for GUID stability check")
    parser.add_argument("--unity-editor", default=None, help="Optional path to Unity Editor binary for batch-mode validation")
    parser.add_argument("--unity-project", default=None, help="Optional path to Unity project for batch-mode validation")
    args = parser.parse_args(argv)

    report = validate_repository(
        repo_root=args.repo_root,
        animations_dir=args.animations_dir,
        animation_rules_path=args.animation_rules,
        cache_path=args.cache_path,
        reports_dir=args.reports_dir,
        base_ref=args.base_ref,
        unity_editor_path=args.unity_editor,
        unity_project_path=args.unity_project,
        write_reports=True,
    )

    status = "PASSED" if report["passed"] else "FAILED"
    print(
        f"Validation {status} ({report['validation_mode']}): "
        f"fbx={report['total_fbx_files']}, "
        f"analyzed_ok={report['successfully_analyzed_files']}, "
        f"invalid_fbx={report['invalid_fbx_files']}, "
        f"missing_meta={report['missing_metadata_files']}, "
        f"orphaned_meta={report['orphaned_metadata_files']}, "
        f"duplicate_guids={report['duplicate_guids']}, "
        f"failed_checks={len(report['failed_validation_checks'])}"
    )
    if not report["passed"]:
        for fc in report["failed_validation_checks"]:
            print(f"  [ERROR] [{fc['code']}] {fc.get('file', '')}: {fc['message']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
