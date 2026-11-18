#!/usr/bin/env python3
"""Automated Unity FBX `ModelImporter` `.meta` Generator.

Generates and maintains genuine Unity-compatible `.meta` sidecar files for FBX
animation assets inside `animations/`:
- Deterministic UUIDv5 GUIDs for new assets
- Strict GUID preservation for existing and renamed/moved assets
- Configurable Humanoid / Generic / Unknown rig handling (never blindly forcing Humanoid)
- Rule-driven animation clip extraction, loop settings, and root motion configuration
- Incremental SHA-256 + Git diff processing for 100-500+ FBX repositories
- Error isolation so invalid FBX files never corrupt valid assets
"""

from __future__ import annotations

import argparse
import copy
import fnmatch
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.analyze_fbx import analyze_fbx_file
from scripts.utils import (
    DEFAULT_GUID_NAMESPACE,
    DEFAULT_HUMANOID_BODY_MASK,
    AssetCache,
    UnityMetaParseError,
    atomic_write_text,
    compute_config_hash,
    compute_sha256,
    derive_clip_name_from_asset,
    detect_git_fbx_changes,
    discover_fbx_files,
    discover_meta_files,
    dump_unity_meta,
    fbx_path_for_meta,
    generate_deterministic_guid,
    is_fbx_meta_file,
    is_valid_unity_guid,
    load_json_config,
    load_unity_meta,
    meta_path_for_fbx,
    normalize_rel_path,
    normalize_unicode,
    parse_unity_meta_text,
    read_git_file_text,
    scan_repository_guids,
    write_json_report,
)

ANIMATION_COMPRESSION_MAP: dict[str | int, int] = {
    0: 0,
    1: 1,
    2: 2,
    3: 3,
    "off": 0,
    "keyframereduction": 1,
    "keyframereductionandcompression": 2,
    "optimal": 3,
}

MESH_COMPRESSION_MAP: dict[str | int, int] = {
    0: 0,
    1: 1,
    2: 2,
    3: 3,
    "off": 0,
    "low": 1,
    "medium": 2,
    "high": 3,
}

MATERIAL_IMPORT_MODE_MAP: dict[str | int, int] = {
    0: 0,
    1: 1,
    2: 2,
    "none": 0,
    "importstandard": 1,
    "standard": 1,
    "importviamaterialdescription": 2,
}

ANIMATION_TYPE_MAP: dict[str | int, int] = {
    0: 0,
    1: 1,
    2: 2,
    3: 3,
    "none": 0,
    "legacy": 1,
    "generic": 2,
    "human": 3,
    "humanoid": 3,
}

AVATAR_SETUP_MAP: dict[str | int, int] = {
    0: 0,
    1: 1,
    2: 2,
    "noavatar": 0,
    "none": 0,
    "createfromthismodel": 1,
    "copyfromother": 2,
    "copyfromotheravatar": 2,
}

MASK_TYPE_MAP: dict[str | int, int] = {
    0: 0,
    1: 1,
    3: 3,
    "createfromthismodel": 0,
    "copyfromother": 1,
    "none": 3,
}


def _enum_val(mapping: dict[str | int, int], raw: Any, default: int) -> int:
    if isinstance(raw, int) and raw in mapping:
        return mapping[raw]
    if isinstance(raw, str):
        key = raw.strip().lower().replace("_", "").replace(" ", "")
        if key in mapping:
            return mapping[key]
    return default


def _deep_merge_dict(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge_dict(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def _find_asset_override(
    rel_path: str, fbx_name: str, animation_rules: dict[str, Any]
) -> dict[str, Any]:
    overrides = animation_rules.get("asset_overrides", {})
    if not isinstance(overrides, dict):
        return {}
    # Exact match takes precedence over glob patterns
    for key in (rel_path, fbx_name):
        if key in overrides and isinstance(overrides[key], dict):
            return overrides[key]
    for pat, val in overrides.items():
        if not isinstance(val, dict):
            continue
        norm_pat = normalize_unicode(str(pat))
        if fnmatch.fnmatch(rel_path, norm_pat) or fnmatch.fnmatch(fbx_name, norm_pat):
            return val
    return {}


def _is_minimally_valid_model_importer(meta_dict: dict[str, Any]) -> bool:
    """Check if parsed `.meta` has core Unity ModelImporter structure."""
    if meta_dict.get("fileFormatVersion") != 2:
        return False
    if not is_valid_unity_guid(meta_dict.get("guid")):
        return False
    mi = meta_dict.get("ModelImporter")
    if not isinstance(mi, dict):
        return False
    if not isinstance(mi.get("animations"), dict) or not isinstance(mi.get("meshes"), dict):
        return False
    if mi.get("animationType") not in (0, 1, 2, 3):
        return False
    return True


def _resolve_rig_configuration(
    analysis: dict[str, Any],
    importer_settings: dict[str, Any],
    asset_override: dict[str, Any],
) -> tuple[int, int, dict[str, Any], str, list[str]]:
    """Determine `(animationType, avatarSetup, avatarSourcePPtr, motionNodeName, warnings)`."""
    rig_cfg = importer_settings.get("rig_settings", {})
    human_cfg = rig_cfg.get("humanoid", {})
    generic_cfg = rig_cfg.get("generic", {})
    warnings: list[str] = []

    rig_info = analysis.get("rig_classification", {})
    detected_rig = rig_info.get("rig_type", "Unknown")
    confidence = float(rig_info.get("confidence", 0.0))
    threshold = float(rig_cfg.get("humanoid_confidence_threshold", 0.85))

    override_rig = asset_override.get("rig_type") or asset_override.get("animation_type")
    if override_rig is not None:
        effective_rig_mode = str(override_rig).strip()
    elif not rig_cfg.get("auto_detect", True):
        effective_rig_mode = "Generic"
    elif detected_rig == "Humanoid" and confidence >= threshold:
        effective_rig_mode = "Humanoid"
    elif detected_rig in ("Humanoid", "Generic"):
        effective_rig_mode = "Generic"
    else:
        policy = str(rig_cfg.get("unknown_rig_policy", "fallback_generic_with_warning")).lower()
        if policy == "fail":
            raise ValueError(
                f"Unknown/unsupported rig in '{analysis.get('file_path')}' and unknown_rig_policy='fail'."
            )
        if policy == "none_animation_type":
            effective_rig_mode = "None"
            warnings.append(
                "Rig structure is Unknown; configured animationType=0 (None) per unknown_rig_policy."
            )
        else:
            effective_rig_mode = "Generic"
            warnings.append(
                "Rig structure could not be verified as Humanoid; configured safely as Generic (avatarSetup=NoAvatar). "
                "Verify rig in Unity Editor if retargeting is needed."
            )

    anim_type = _enum_val(ANIMATION_TYPE_MAP, effective_rig_mode, 2)
    motion_node = str(
        asset_override.get("root_motion_bone_name", generic_cfg.get("root_motion_bone_name", ""))
    )

    if anim_type == 3:  # Humanoid
        raw_setup = asset_override.get("avatar_setup", human_cfg.get("avatar_setup", "CreateFromThisModel"))
        avatar_setup = _enum_val(AVATAR_SETUP_MAP, raw_setup, 1)
        src_guid = str(
            asset_override.get("source_avatar_guid", human_cfg.get("source_avatar_guid", ""))
        ).strip().lower()
        src_file_id = int(
            asset_override.get("source_avatar_file_id", human_cfg.get("source_avatar_file_id", 9000000))
        )
        if avatar_setup == 2:
            if is_valid_unity_guid(src_guid):
                avatar_pptr: dict[str, Any] = {
                    "fileID": src_file_id,
                    "guid": src_guid,
                    "type": 3,
                }
            else:
                warnings.append(
                    "Humanoid avatar_setup='CopyFromOther' requested without a valid 32-hex source_avatar_guid; "
                    "falling back to 'CreateFromThisModel' (avatarSetup=1)."
                )
                avatar_setup = 1
                avatar_pptr = {"instanceID": 0}
        else:
            avatar_pptr = {"instanceID": 0}
    elif anim_type == 2:  # Generic
        if detected_rig == "Unknown" and override_rig is None:
            avatar_setup = 0  # NoAvatar when no skeleton bones exist
        else:
            raw_setup = asset_override.get(
                "avatar_setup", generic_cfg.get("avatar_setup", "CreateFromThisModel")
            )
            avatar_setup = _enum_val(AVATAR_SETUP_MAP, raw_setup, 1)
        src_guid = str(asset_override.get("source_avatar_guid", "")).strip().lower()
        src_file_id = int(asset_override.get("source_avatar_file_id", 9000000))
        if avatar_setup == 2 and is_valid_unity_guid(src_guid):
            avatar_pptr = {"fileID": src_file_id, "guid": src_guid, "type": 3}
        else:
            if avatar_setup == 2:
                avatar_setup = 1
            avatar_pptr = {"instanceID": 0}
    else:
        avatar_setup = 0
        avatar_pptr = {"instanceID": 0}

    return anim_type, avatar_setup, avatar_pptr, motion_node, warnings


def _build_clip_entry(
    *,
    clip_name: str,
    take_name: str,
    first_frame: float | int,
    last_frame: float | int,
    clip_cfg: dict[str, Any],
    is_humanoid: bool,
    existing_clip: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Construct a single Unity `ModelImporterClipAnimation` (`serializedVersion: 16`) entry."""
    rot_cfg = clip_cfg.get("root_transform_rotation", {})
    posy_cfg = clip_cfg.get("root_transform_position_y", {})
    posxz_cfg = clip_cfg.get("root_transform_position_xz", {})

    rot_based = str(rot_cfg.get("based_upon", "Original")).strip().lower()
    keep_orig_rot = 1 if rot_based == "original" else 0

    posy_based = str(posy_cfg.get("based_upon", "Original")).strip().lower()
    if posy_based == "feet" and is_humanoid:
        keep_orig_y = 0
        height_from_feet = 1
    elif posy_based in ("centerofmass", "bodyorientation"):
        keep_orig_y = 0
        height_from_feet = 0
    else:
        keep_orig_y = 1
        height_from_feet = 0

    posxz_based = str(posxz_cfg.get("based_upon", "Original")).strip().lower()
    keep_orig_xz = 1 if posxz_based == "original" else 0

    mask_type = _enum_val(MASK_TYPE_MAP, clip_cfg.get("mask_type", "None"), 3)
    mask_guid = str(clip_cfg.get("mask_source_guid", "")).strip().lower()
    mask_file_id = int(clip_cfg.get("mask_source_file_id", 31900000))
    if mask_type == 1 and is_valid_unity_guid(mask_guid):
        mask_source: dict[str, Any] = {"fileID": mask_file_id, "guid": mask_guid, "type": 2}
    else:
        if mask_type == 1:
            mask_type = 3
        mask_source = {"instanceID": 0}

    entry: dict[str, Any] = {
        "serializedVersion": 16,
        "name": clip_name,
        "takeName": take_name,
        "internalID": int(existing_clip.get("internalID", 0)) if existing_clip else 0,
        "firstFrame": first_frame,
        "lastFrame": last_frame,
        "wrapMode": int(clip_cfg.get("wrap_mode", 0)),
        "orientationOffsetY": float(rot_cfg.get("offset", 0.0)),
        "level": float(posy_cfg.get("offset", 0.0)),
        "cycleOffset": float(clip_cfg.get("cycle_offset", 0.0)),
        "loop": 0,
        "hasAdditiveReferencePose": 1 if clip_cfg.get("has_additive_reference_pose", False) else 0,
        "loopTime": 1 if clip_cfg.get("loop_time", False) else 0,
        "loopBlend": 1 if clip_cfg.get("loop_pose", False) else 0,
        "loopBlendOrientation": 1 if rot_cfg.get("bake_into_pose", False) else 0,
        "loopBlendPositionY": 1 if posy_cfg.get("bake_into_pose", True) else 0,
        "loopBlendPositionXZ": 1 if posxz_cfg.get("bake_into_pose", False) else 0,
        "keepOriginalOrientation": keep_orig_rot,
        "keepOriginalPositionY": keep_orig_y,
        "keepOriginalPositionXZ": keep_orig_xz,
        "heightFromFeet": height_from_feet,
        "mirror": 1 if clip_cfg.get("mirror", False) else 0,
        "bodyMask": (
            str(existing_clip["bodyMask"])
            if existing_clip and isinstance(existing_clip.get("bodyMask"), str) and len(str(existing_clip["bodyMask"])) == 104
            else DEFAULT_HUMANOID_BODY_MASK
        ),
        "curves": copy.deepcopy(existing_clip["curves"]) if existing_clip and isinstance(existing_clip.get("curves"), list) else [],
        "events": copy.deepcopy(existing_clip["events"]) if existing_clip and isinstance(existing_clip.get("events"), list) else [],
        "transformMask": copy.deepcopy(existing_clip["transformMask"]) if existing_clip and isinstance(existing_clip.get("transformMask"), list) else [],
        "maskType": mask_type,
        "maskSource": mask_source,
        "additiveReferencePoseFrame": float(clip_cfg.get("additive_reference_pose_frame", 0.0)),
    }
    return entry


def build_model_importer_meta(
    *,
    guid: str,
    fbx_path: Path,
    analysis: dict[str, Any],
    importer_settings: dict[str, Any],
    animation_rules: dict[str, Any],
    existing_meta: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Build a complete, genuine Unity `ModelImporter` `.meta` structure."""
    rel_path = analysis["file_path"]
    asset_override = _find_asset_override(rel_path, fbx_path.name, animation_rules)

    anim_type, avatar_setup, avatar_pptr, motion_node, warnings = _resolve_rig_configuration(
        analysis, importer_settings, asset_override
    )
    is_humanoid = anim_type == 3

    anim_import_cfg = importer_settings.get("animation_import", {})
    mesh_cfg = importer_settings.get("mesh_import", {})
    clip_defaults = importer_settings.get("clip_defaults", {})
    human_cfg = importer_settings.get("rig_settings", {}).get("humanoid", {})

    # Merge clip configuration: defaults <- category clip_overrides <- per-asset override
    cat_name = analysis.get("animation_category", {}).get("category", "Other")
    cat_entry = animation_rules.get("categories", {}).get(cat_name, {})
    cat_clip_overrides = cat_entry.get("clip_overrides", {}) if isinstance(cat_entry, dict) else {}

    merged_clip_cfg = _deep_merge_dict(clip_defaults, cat_clip_overrides)
    for ov_key in (
        "loop_time",
        "loop_pose",
        "cycle_offset",
        "wrap_mode",
        "mirror",
        "has_additive_reference_pose",
        "additive_reference_pose_frame",
        "root_transform_rotation",
        "root_transform_position_y",
        "root_transform_position_xz",
        "mask_type",
        "mask_source_guid",
        "mask_source_file_id",
    ):
        if ov_key in asset_override:
            if isinstance(asset_override[ov_key], dict) and isinstance(
                merged_clip_cfg.get(ov_key), dict
            ):
                merged_clip_cfg[ov_key] = _deep_merge_dict(
                    merged_clip_cfg[ov_key], asset_override[ov_key]
                )
            else:
                merged_clip_cfg[ov_key] = copy.deepcopy(asset_override[ov_key])

    # Filter takes (skip bind-pose helper takes if real animation takes also exist)
    raw_takes: list[dict[str, Any]] = list(analysis.get("takes", []))
    ignore_pose_names = {
        s.strip().lower() for s in clip_defaults.get("ignore_bind_pose_takes", [])
    }
    filtered_takes = [
        t
        for t in raw_takes
        if t["name"].strip().lower() not in ignore_pose_names
        and (t["keyframe_count"] > 0 or t["duration_sec"] > 0 or t["curve_count"] > 0)
    ]
    if not filtered_takes:
        filtered_takes = raw_takes

    strip_at = bool(clip_defaults.get("strip_at_prefix", True))
    default_asset_clip_name = derive_clip_name_from_asset(fbx_path, strip_at_prefix=strip_at)
    generic_take_set = {
        s.strip().lower()
        for s in clip_defaults.get(
            "generic_take_names", ["Take 001", "Default Take", "mixamo.com"]
        )
    }

    existing_mi = (
        existing_meta.get("ModelImporter", {})
        if isinstance(existing_meta, dict) and isinstance(existing_meta.get("ModelImporter"), dict)
        else {}
    )
    existing_clips_by_take: dict[str, dict[str, Any]] = {}
    existing_anim_sec = existing_mi.get("animations", {})
    if isinstance(existing_anim_sec, dict) and isinstance(
        existing_anim_sec.get("clipAnimations"), list
    ):
        for ec in existing_anim_sec["clipAnimations"]:
            if isinstance(ec, dict) and isinstance(ec.get("takeName"), str):
                existing_clips_by_take[ec["takeName"]] = ec

    clip_animations: list[dict[str, Any]] = []
    used_clip_names: set[str] = set()

    # Check if user specified explicit `clips` array override in asset_override
    explicit_clips_ov = asset_override.get("clips")
    if isinstance(explicit_clips_ov, list) and explicit_clips_ov:
        fallback_take = filtered_takes[0] if filtered_takes else {"name": "Take 001", "start_frame": 0, "end_frame": 30}
        for idx, cov in enumerate(explicit_clips_ov):
            if not isinstance(cov, dict):
                continue
            cname = str(cov.get("name") or f"{default_asset_clip_name}_{idx + 1}")
            tname = str(cov.get("take_name") or fallback_take["name"])
            ff = cov.get("first_frame", fallback_take.get("start_frame", 0))
            lf = cov.get("last_frame", fallback_take.get("end_frame", 30))
            per_clip_cfg = _deep_merge_dict(merged_clip_cfg, cov)
            clip_animations.append(
                _build_clip_entry(
                    clip_name=cname,
                    take_name=tname,
                    first_frame=ff,
                    last_frame=lf,
                    clip_cfg=per_clip_cfg,
                    is_humanoid=is_humanoid,
                    existing_clip=existing_clips_by_take.get(tname),
                )
            )
    else:
        for idx, take in enumerate(filtered_takes):
            take_name = str(take["name"])
            prev_clip = existing_clips_by_take.get(take_name)

            if "clip_name" in asset_override and len(filtered_takes) == 1:
                base_name = str(asset_override["clip_name"]).strip()
            elif prev_clip and isinstance(prev_clip.get("name"), str) and prev_clip["name"].strip():
                base_name = prev_clip["name"].strip()
            elif len(filtered_takes) == 1 and (
                take_name.strip().lower() in generic_take_set
                or clip_defaults.get("naming_strategy") == "always_asset_stem_for_single_take"
            ):
                base_name = default_asset_clip_name
            else:
                # Strip Armature|Take prefix common in Blender exports
                clean_take = take_name.split("|", 1)[-1].strip() if "|" in take_name else take_name.strip()
                base_name = (
                    default_asset_clip_name
                    if clean_take.lower() in generic_take_set
                    else (clean_take or default_asset_clip_name)
                )

            clip_name = base_name
            suffix = 2
            while clip_name in used_clip_names:
                clip_name = f"{base_name}_{suffix}"
                suffix += 1
            used_clip_names.add(clip_name)

            ff = asset_override.get("first_frame", take.get("start_frame", 0))
            lf = asset_override.get("last_frame", take.get("end_frame", 1))
            if lf < ff:
                lf = ff

            clip_animations.append(
                _build_clip_entry(
                    clip_name=clip_name,
                    take_name=take_name,
                    first_frame=ff,
                    last_frame=lf,
                    clip_cfg=merged_clip_cfg,
                    is_humanoid=is_humanoid,
                    existing_clip=prev_clip,
                )
            )

    disable_mesh_extras = bool(
        asset_override.get(
            "disable_mesh_import", mesh_cfg.get("disable_for_animation_only", True)
        )
    )

    mat_mode = (
        0
        if disable_mesh_extras
        else _enum_val(
            MATERIAL_IMPORT_MODE_MAP, mesh_cfg.get("material_import_mode", "None"), 0
        )
    )
    import_blend_shapes = (
        1
        if asset_override.get("import_blend_shapes", mesh_cfg.get("import_blend_shapes", False))
        else 0
    )
    import_visibility = 0 if disable_mesh_extras else (1 if mesh_cfg.get("import_visibility", False) else 0)
    import_cameras = 0 if disable_mesh_extras else (1 if mesh_cfg.get("import_cameras", False) else 0)
    import_lights = 0 if disable_mesh_extras else (1 if mesh_cfg.get("import_lights", False) else 0)
    add_colliders = 0 if disable_mesh_extras else (1 if mesh_cfg.get("add_colliders", False) else 0)
    normal_import_mode = 2 if disable_mesh_extras else 0
    tangent_import_mode = 2 if disable_mesh_extras else 3
    blend_normal_mode = 2 if disable_mesh_extras else 1

    import_anim_flag = (
        1
        if asset_override.get("import_animation", anim_import_cfg.get("enabled", True))
        else 0
    )
    anim_compression = _enum_val(
        ANIMATION_COMPRESSION_MAP,
        asset_override.get(
            "animation_compression", anim_import_cfg.get("animation_compression", "Optimal")
        ),
        3,
    )
    mesh_compression = _enum_val(
        MESH_COMPRESSION_MAP, mesh_cfg.get("mesh_compression", "Off"), 0
    )

    has_extra_root = (
        1
        if analysis.get("rig_classification", {}).get("has_extra_root", False)
        else 0
    )

    # Preserve Unity-generated sub-asset recycle tables & custom HumanDescription if present
    internal_id_table = (
        copy.deepcopy(existing_mi["internalIDToNameTable"])
        if isinstance(existing_mi.get("internalIDToNameTable"), list)
        else []
    )
    external_objects = (
        copy.deepcopy(existing_mi["externalObjects"])
        if isinstance(existing_mi.get("externalObjects"), (dict, list))
        else {}
    )
    existing_hd = existing_mi.get("humanDescription")
    if (
        isinstance(existing_hd, dict)
        and isinstance(existing_hd.get("human"), list)
        and len(existing_hd["human"]) > 0
    ):
        human_description = copy.deepcopy(existing_hd)
    else:
        human_description = {
            "serializedVersion": 3,
            "human": [],
            "skeleton": [],
            "armTwist": float(human_cfg.get("arm_twist", 0.5)),
            "foreArmTwist": float(human_cfg.get("fore_arm_twist", 0.5)),
            "upperLegTwist": float(human_cfg.get("upper_leg_twist", 0.5)),
            "legTwist": float(human_cfg.get("leg_twist", 0.5)),
            "armStretch": float(human_cfg.get("arm_stretch", 0.05)),
            "legStretch": float(human_cfg.get("leg_stretch", 0.05)),
            "feetSpacing": float(human_cfg.get("feet_spacing", 0.0)),
            "globalScale": float(mesh_cfg.get("global_scale", 1.0)),
            "rootMotionBoneName": motion_node if anim_type == 2 else "",
            "hasTranslationDoF": 1 if human_cfg.get("has_translation_dof", False) else 0,
            "hasExtraRoot": has_extra_root,
            "skeletonHasParents": 1,
        }

    serialized_version = int(importer_settings.get("unity_serialized_version", 22200))

    meta_dict: dict[str, Any] = {
        "fileFormatVersion": 2,
        "guid": guid,
        "ModelImporter": {
            "serializedVersion": serialized_version,
            "internalIDToNameTable": internal_id_table,
            "externalObjects": external_objects,
            "materials": {
                "materialImportMode": mat_mode,
                "materialName": 0,
                "materialSearch": 1,
                "materialLocation": 1,
            },
            "animations": {
                "legacyGenerateAnimations": 4,
                "bakeSimulation": 1 if anim_import_cfg.get("bake_simulation", False) else 0,
                "resampleCurves": 1 if asset_override.get("resample_curves", anim_import_cfg.get("resample_curves", True)) else 0,
                "optimizeGameObjects": 1 if anim_import_cfg.get("optimize_game_objects", False) else 0,
                "removeConstantScaleCurves": 1 if anim_import_cfg.get("remove_constant_scale_curves", True) else 0,
                "motionNodeName": motion_node,
                "rigImportErrors": "",
                "rigImportWarnings": "",
                "animationImportErrors": "",
                "animationImportWarnings": "",
                "animationRetargetingWarnings": "",
                "animationDoRetargetingWarnings": 0,
                "importAnimatedCustomProperties": 1 if anim_import_cfg.get("import_animated_custom_properties", False) else 0,
                "importConstraints": 1 if anim_import_cfg.get("import_constraints", False) else 0,
                "animationCompression": anim_compression,
                "animationRotationError": float(anim_import_cfg.get("rotation_error", 0.5)),
                "animationPositionError": float(anim_import_cfg.get("position_error", 0.5)),
                "animationScaleError": float(anim_import_cfg.get("scale_error", 0.5)),
                "animationWrapMode": int(anim_import_cfg.get("animation_wrap_mode", 0)),
                "extraExposedTransformPaths": (
                    copy.deepcopy(existing_anim_sec["extraExposedTransformPaths"])
                    if isinstance(existing_anim_sec, dict) and isinstance(existing_anim_sec.get("extraExposedTransformPaths"), list)
                    else []
                ),
                "extraUserProperties": (
                    copy.deepcopy(existing_anim_sec["extraUserProperties"])
                    if isinstance(existing_anim_sec, dict) and isinstance(existing_anim_sec.get("extraUserProperties"), list)
                    else []
                ),
                "clipAnimations": clip_animations,
                "isReadable": 1 if mesh_cfg.get("is_readable", False) else 0,
            },
            "meshes": {
                "lODScreenPercentages": [],
                "globalScale": float(mesh_cfg.get("global_scale", 1.0)),
                "meshCompression": mesh_compression,
                "addColliders": add_colliders,
                "useSRGBMaterialColor": 1,
                "sortHierarchyByName": 1 if mesh_cfg.get("sort_hierarchy_by_name", True) else 0,
                "importVisibility": import_visibility,
                "importBlendShapes": import_blend_shapes,
                "importCameras": import_cameras,
                "importLights": import_lights,
                "nodeNameCollisionStrategy": 1,
                "fileIdsGeneration": int(mesh_cfg.get("file_ids_generation", 2)),
                "swapUVChannels": 0,
                "generateSecondaryUV": 1 if mesh_cfg.get("generate_secondary_uv", False) else 0,
                "useFileUnits": 1 if mesh_cfg.get("use_file_units", True) else 0,
                "keepQuads": 0,
                "weldVertices": 1,
                "bakeAxisConversion": 1 if mesh_cfg.get("bake_axis_conversion", False) else 0,
                "preserveHierarchy": 1 if mesh_cfg.get("preserve_hierarchy", False) else 0,
                "skinWeightsMode": int(mesh_cfg.get("skin_weights_mode", 0)),
                "maxBonesPerVertex": int(mesh_cfg.get("max_bones_per_vertex", 4)),
                "minBoneWeight": float(mesh_cfg.get("min_bone_weight", 0.001)),
                "optimizeBones": 1 if mesh_cfg.get("optimize_bones", True) else 0,
                "meshOptimizationFlags": -1,
                "indexFormat": 0,
                "secondaryUVAngleDistortion": 8,
                "secondaryUVAreaDistortion": 15.000001,
                "secondaryUVHardAngle": 88,
                "secondaryUVMarginMethod": 1,
                "secondaryUVMinLightmapResolution": 40,
                "secondaryUVMinObjectScale": 1,
                "secondaryUVPackMargin": 4,
                "useFileScale": 1 if mesh_cfg.get("use_file_scale", True) else 0,
            },
            "tangentSpace": {
                "normalSmoothAngle": 60,
                "normalImportMode": normal_import_mode,
                "tangentImportMode": tangent_import_mode,
                "normalCalculationMode": 4,
                "legacyComputeAllNormalsFromSmoothingGroupsWhenMeshHasBlendShapes": 0,
                "blendShapeNormalImportMode": blend_normal_mode,
                "normalSmoothingSource": 0,
            },
            "referencedClips": (
                copy.deepcopy(existing_mi["referencedClips"])
                if isinstance(existing_mi.get("referencedClips"), list)
                else []
            ),
            "importAnimation": import_anim_flag,
            "humanDescription": human_description,
            "lastHumanDescriptionAvatarSource": avatar_pptr,
            "autoGenerateAvatarMappingIfUnspecified": (
                1 if human_cfg.get("auto_generate_avatar_mapping_if_unspecified", True) else 0
            ),
            "animationType": anim_type,
            "humanoidOversampling": int(human_cfg.get("humanoid_oversampling", 1)),
            "avatarSetup": avatar_setup,
            "addHumanoidExtraRootOnlyWhenUsingAvatar": (
                1 if human_cfg.get("add_humanoid_extra_root_only_when_using_avatar", True) else 0
            ),
            "remapMaterialsIfMaterialImportModeIsNone": 0,
            "additionalBone": 0,
            "userData": str(existing_mi.get("userData", "")) if existing_mi.get("userData") is not None else "",
            "assetBundleName": str(existing_mi.get("assetBundleName", "")) if existing_mi.get("assetBundleName") is not None else "",
            "assetBundleVariant": str(existing_mi.get("assetBundleVariant", "")) if existing_mi.get("assetBundleVariant") is not None else "",
        },
    }

    # Preserve extra top-level sections (e.g. AssetOrigin) if present in existing .meta
    if isinstance(existing_meta, dict):
        for extra_k, extra_v in existing_meta.items():
            if extra_k not in ("fileFormatVersion", "guid", "ModelImporter"):
                meta_dict[extra_k] = copy.deepcopy(extra_v)

    return meta_dict, warnings


def _update_existing_meta_clips_on_fbx_change(
    existing_meta: dict[str, Any],
    *,
    fbx_path: Path,
    analysis: dict[str, Any],
    importer_settings: dict[str, Any],
    animation_rules: dict[str, Any],
) -> dict[str, Any]:
    """Update clip frame ranges / new takes on an existing valid `.meta` while preserving GUID & settings."""
    updated = copy.deepcopy(existing_meta)
    mi = updated.get("ModelImporter", {})
    anim_sec = mi.get("animations", {})
    existing_clips = anim_sec.get("clipAnimations", [])
    if not isinstance(existing_clips, list):
        existing_clips = []

    fresh_meta, _ = build_model_importer_meta(
        guid=str(updated["guid"]),
        fbx_path=fbx_path,
        analysis=analysis,
        importer_settings=importer_settings,
        animation_rules=animation_rules,
        existing_meta=existing_meta,
    )
    fresh_clips = fresh_meta["ModelImporter"]["animations"]["clipAnimations"]
    fresh_by_take = {c["takeName"]: c for c in fresh_clips}

    merged_clips: list[dict[str, Any]] = []
    seen_takes: set[str] = set()
    for ec in existing_clips:
        if not isinstance(ec, dict):
            continue
        tname = ec.get("takeName")
        if isinstance(tname, str) and tname in fresh_by_take:
            fc = fresh_by_take[tname]
            ec_copy = copy.deepcopy(ec)
            ec_copy["firstFrame"] = fc["firstFrame"]
            ec_copy["lastFrame"] = fc["lastFrame"]
            merged_clips.append(ec_copy)
            seen_takes.add(tname)
        else:
            merged_clips.append(copy.deepcopy(ec))

    for fc in fresh_clips:
        if fc["takeName"] not in seen_takes:
            merged_clips.append(fc)

    anim_sec["clipAnimations"] = merged_clips
    return updated


def generate_metadata_pipeline(
    *,
    repo_root: Path | str,
    animations_dir: Path | str | None = None,
    importer_settings_path: Path | str | None = None,
    animation_rules_path: Path | str | None = None,
    cache_path: Path | str | None = None,
    reports_dir: Path | str | None = None,
    incremental: bool = False,
    base_ref: str | None = None,
    reconfigure_existing: bool = False,
    dry_run: bool = False,
    use_blender: bool = False,
) -> dict[str, Any]:
    """Run the end-to-end FBX analysis and `.meta` generation pipeline."""
    root = Path(repo_root).resolve()
    anim_dir = Path(animations_dir).resolve() if animations_dir else (root / "animations")
    settings_file = (
        Path(importer_settings_path).resolve()
        if importer_settings_path
        else (root / "config" / "importer_settings.json")
    )
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

    importer_settings = load_json_config(settings_file)
    animation_rules = load_json_config(rules_file)
    cfg_hash = compute_config_hash(settings_file, rules_file)

    guid_ns = importer_settings.get("guid_namespace", str(DEFAULT_GUID_NAMESPACE))
    preserve_existing = bool(importer_settings.get("preserve_existing_meta", True))
    update_on_fbx_change = bool(importer_settings.get("update_clips_when_fbx_changes", True))
    clean_orphans = bool(importer_settings.get("clean_orphaned_meta", True))

    cache = AssetCache(cache_file)
    cache.config_hash = cfg_hash

    anim_rel_dir = normalize_rel_path(anim_dir, root) if anim_dir.is_relative_to(root) else "animations"
    git_changes = detect_git_fbx_changes(root, animations_rel_dir=anim_rel_dir, base_ref=base_ref)

    all_fbx_files = discover_fbx_files(anim_dir)
    all_fbx_rel_map: dict[str, Path] = {
        normalize_rel_path(p, root): p for p in all_fbx_files
    }

    # Scan existing repository GUIDs before making changes
    guid_to_paths, path_to_guid = scan_repository_guids(root)
    used_guids: dict[str, str] = {}  # guid -> owner meta_rel_path
    duplicate_existing_guids: dict[str, list[str]] = {}
    for g, mpaths in guid_to_paths.items():
        # Filter out orphaned .meta files whose FBX no longer exists from blocking rename migration
        active_mpaths = [
            mp for mp in mpaths if not is_fbx_meta_file(mp) or fbx_path_for_meta(root / mp).exists()
        ]
        if len(active_mpaths) > 1:
            duplicate_existing_guids[g] = active_mpaths
        if active_mpaths:
            used_guids[g] = active_mpaths[0]
        elif mpaths:
            used_guids[g] = mpaths[0]

    # Pre-compute SHA-256 of new FBXs lacking .meta so cache-based rename detection is unambiguous
    unmeta_sha_counts: dict[str, int] = {}
    unmeta_shas: dict[str, str] = {}
    for rel_p, full_p in all_fbx_rel_map.items():
        if not meta_path_for_fbx(full_p).exists() and full_p.is_file() and full_p.stat().st_size > 0:
            sha = compute_sha256(full_p)
            unmeta_shas[rel_p] = sha
            unmeta_sha_counts[sha] = unmeta_sha_counts.get(sha, 0) + 1

    # Determine which files need inspection in incremental mode
    incremental_targets: set[str] | None = None
    if incremental and not reconfigure_existing and git_changes.is_git_repo:
        incremental_targets = set(git_changes.added_or_modified) | set(git_changes.renamed.keys())
        for rel_p, full_p in all_fbx_rel_map.items():
            if not meta_path_for_fbx(full_p).exists():
                incremental_targets.add(rel_p)

    generated_files: list[str] = []
    updated_files: list[str] = []
    migrated_files: list[dict[str, str]] = []
    preserved_files: list[str] = []
    skipped_unchanged_files: list[str] = []
    removed_orphaned_meta: list[str] = []
    invalid_files: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    analysis_results: list[dict[str, Any]] = []

    for g, conflicting_paths in sorted(duplicate_existing_guids.items()):
        errors.append(
            {
                "code": "DUPLICATE_EXISTING_GUID",
                "guid": g,
                "files": conflicting_paths,
                "message": (
                    f"Duplicate GUID '{g}' already exists across multiple .meta files: "
                    f"{', '.join(conflicting_paths)}. Refusing to silently reassign existing asset GUIDs."
                ),
            }
        )

    consumed_orphan_metas: set[str] = set()

    for rel_p in sorted(all_fbx_rel_map.keys()):
        fbx_path = all_fbx_rel_map[rel_p]
        meta_path = meta_path_for_fbx(fbx_path)
        meta_rel_path = normalize_rel_path(meta_path, root)

        # Fast-path skip in incremental mode when unchanged & valid .meta exists on disk
        if (
            incremental_targets is not None
            and rel_p not in incremental_targets
            and meta_path.exists()
        ):
            cached_entry = cache.get_entry(rel_p)
            if cached_entry and isinstance(cached_entry.get("analysis"), dict):
                analysis_results.append(cached_entry["analysis"])
            preserved_files.append(meta_rel_path)
            skipped_unchanged_files.append(rel_p)
            continue

        # Compute SHA-256 and check cache for analysis reuse
        try:
            fsize = fbx_path.stat().st_size
        except OSError as exc:
            errors.append(
                {
                    "code": "IO_ERROR",
                    "file": rel_p,
                    "message": f"Unable to stat FBX file: {exc}",
                }
            )
            continue

        sha256 = unmeta_shas.get(rel_p) or (compute_sha256(fbx_path) if fsize > 0 else "")
        cached_entry = cache.get_entry(rel_p)

        if (
            cached_entry
            and fsize > 0
            and cached_entry.get("sha256") == sha256
            and isinstance(cached_entry.get("analysis"), dict)
            and not use_blender
        ):
            analysis = copy.deepcopy(cached_entry["analysis"])
            # Refresh category in case animation_rules.json changed
            from scripts.analyze_fbx import classify_animation_category

            analysis["animation_category"] = classify_animation_category(
                rel_path=rel_p,
                fbx_path=fbx_path,
                take_names=[t["name"] for t in analysis.get("takes", [])],
                animation_rules=animation_rules,
            )
        else:
            analysis = analyze_fbx_file(
                fbx_path,
                repo_root=root,
                animation_rules=animation_rules,
                use_blender=use_blender,
            )

        analysis_results.append(analysis)

        if not analysis["is_valid"]:
            invalid_files.append(
                {
                    "file": rel_p,
                    "error_code": analysis["error_code"],
                    "errors": analysis["errors"],
                }
            )
            errors.append(
                {
                    "code": analysis["error_code"] or "INVALID_FBX",
                    "file": rel_p,
                    "message": "; ".join(analysis["errors"]) or "FBX analysis failed.",
                }
            )
            continue

        # Case 1: `.meta` already exists at target path
        if meta_path.exists():
            try:
                existing_meta = load_unity_meta(meta_path)
            except UnityMetaParseError as exc:
                errors.append(
                    {
                        "code": "INVALID_EXISTING_META",
                        "file": meta_rel_path,
                        "message": (
                            f"Existing metadata '{meta_rel_path}' is corrupted and cannot be safely parsed: {exc}. "
                            "Refusing to silently assign a new GUID."
                        ),
                    }
                )
                continue

            existing_guid = existing_meta.get("guid")
            if not is_valid_unity_guid(existing_guid):
                errors.append(
                    {
                        "code": "INVALID_EXISTING_GUID",
                        "file": meta_rel_path,
                        "message": (
                            f"Existing metadata '{meta_rel_path}' has invalid GUID {existing_guid!r}. "
                            "Refusing to silently overwrite asset GUID."
                        ),
                    }
                )
                continue

            fbx_changed = bool(
                (cached_entry and cached_entry.get("sha256") and cached_entry.get("sha256") != sha256)
                or (rel_p in git_changes.added_or_modified and cached_entry is not None and cached_entry.get("sha256") != sha256)
            )

            if (
                preserve_existing
                and not reconfigure_existing
                and _is_minimally_valid_model_importer(existing_meta)
            ):
                if fbx_changed and update_on_fbx_change:
                    updated_meta = _update_existing_meta_clips_on_fbx_change(
                        existing_meta,
                        fbx_path=fbx_path,
                        analysis=analysis,
                        importer_settings=importer_settings,
                        animation_rules=animation_rules,
                    )
                    rendered = dump_unity_meta(updated_meta)
                    changed_on_disk = False if dry_run else atomic_write_text(meta_path, rendered)
                    if dry_run:
                        changed_on_disk = meta_path.read_text(encoding="utf-8") != rendered
                    if changed_on_disk:
                        updated_files.append(meta_rel_path)
                    else:
                        preserved_files.append(meta_rel_path)
                else:
                    preserved_files.append(meta_rel_path)

                if not dry_run:
                    cache.set_entry(
                        rel_p,
                        sha256=sha256,
                        size_bytes=fsize,
                        guid=str(existing_guid),
                        analysis=analysis,
                    )
                continue

            # Reconfigure or repair incomplete ModelImporter while STRICTLY keeping existing_guid
            try:
                rebuilt_meta, build_warnings = build_model_importer_meta(
                    guid=str(existing_guid),
                    fbx_path=fbx_path,
                    analysis=analysis,
                    importer_settings=importer_settings,
                    animation_rules=animation_rules,
                    existing_meta=existing_meta,
                )
                analysis["warnings"].extend(build_warnings)
            except ValueError as exc:
                errors.append({"code": "RIG_CONFIG_ERROR", "file": rel_p, "message": str(exc)})
                continue

            rendered = dump_unity_meta(rebuilt_meta)
            changed_on_disk = (
                meta_path.read_text(encoding="utf-8") != rendered
                if dry_run
                else atomic_write_text(meta_path, rendered)
            )
            if changed_on_disk:
                updated_files.append(meta_rel_path)
            else:
                preserved_files.append(meta_rel_path)
            if not dry_run:
                cache.set_entry(
                    rel_p,
                    sha256=sha256,
                    size_bytes=fsize,
                    guid=str(existing_guid),
                    analysis=analysis,
                )
            continue

        # Case 2: No `.meta` at target path -> Check if asset was renamed/moved!
        recovered_old_rel: str | None = None
        recovered_meta_dict: dict[str, Any] | None = None
        recovered_guid: str | None = None

        if rel_p in git_changes.renamed:
            cand_old_rel = git_changes.renamed[rel_p]
            if not (root / cand_old_rel).exists():
                recovered_old_rel = cand_old_rel
        elif unmeta_sha_counts.get(sha256, 0) == 1:
            # Check persistent cache for unambiguously missing asset with identical SHA-256
            missing_matches = cache.find_missing_paths_by_sha256(sha256, root)
            if len(missing_matches) == 1:
                recovered_old_rel, match_info = missing_matches[0]
                if is_valid_unity_guid(match_info.get("guid")):
                    recovered_guid = str(match_info["guid"])

        if recovered_old_rel:
            old_meta_rel = f"{recovered_old_rel}.meta"
            old_meta_disk = root / old_meta_rel
            if old_meta_disk.exists():
                try:
                    parsed_old = load_unity_meta(old_meta_disk)
                    if is_valid_unity_guid(parsed_old.get("guid")):
                        recovered_meta_dict = parsed_old
                        recovered_guid = str(parsed_old["guid"])
                        consumed_orphan_metas.add(old_meta_rel)
                except UnityMetaParseError:
                    pass
            elif git_changes.base_ref:
                hist_text = read_git_file_text(root, git_changes.base_ref, old_meta_rel)
                if hist_text:
                    try:
                        parsed_hist = parse_unity_meta_text(hist_text, source_name=old_meta_rel)
                        if is_valid_unity_guid(parsed_hist.get("guid")):
                            recovered_meta_dict = parsed_hist
                            recovered_guid = str(parsed_hist["guid"])
                    except UnityMetaParseError:
                        pass

        # Also check if this exact path previously existed in Git HEAD / cache (e.g. accidental .meta deletion)
        if recovered_guid is None:
            if cached_entry and is_valid_unity_guid(cached_entry.get("guid")):
                cand_g = str(cached_entry["guid"])
                owner = used_guids.get(cand_g)
                if owner is None or owner == meta_rel_path:
                    recovered_guid = cand_g
            elif git_changes.base_ref:
                hist_self = read_git_file_text(root, git_changes.base_ref, meta_rel_path)
                if hist_self:
                    try:
                        parsed_self = parse_unity_meta_text(hist_self, source_name=meta_rel_path)
                        if is_valid_unity_guid(parsed_self.get("guid")):
                            cand_g = str(parsed_self["guid"])
                            if used_guids.get(cand_g) in (None, meta_rel_path):
                                recovered_guid = cand_g
                                recovered_meta_dict = parsed_self
                    except UnityMetaParseError:
                        pass

        if recovered_guid is not None:
            # Ensure recovered GUID doesn't collide with a *different* active asset
            existing_owner = used_guids.get(recovered_guid)
            old_meta_rel_check = f"{recovered_old_rel}.meta" if recovered_old_rel else None
            if existing_owner not in (None, meta_rel_path, old_meta_rel_check):
                errors.append(
                    {
                        "code": "RENAME_GUID_COLLISION",
                        "file": rel_p,
                        "message": (
                            f"Recovered GUID '{recovered_guid}' for '{rel_p}' conflicts with active "
                            f"metadata '{existing_owner}'."
                        ),
                    }
                )
                continue

            if recovered_meta_dict and _is_minimally_valid_model_importer(recovered_meta_dict):
                target_meta = copy.deepcopy(recovered_meta_dict)
            else:
                try:
                    target_meta, build_warnings = build_model_importer_meta(
                        guid=recovered_guid,
                        fbx_path=fbx_path,
                        analysis=analysis,
                        importer_settings=importer_settings,
                        animation_rules=animation_rules,
                        existing_meta=recovered_meta_dict,
                    )
                    analysis["warnings"].extend(build_warnings)
                except ValueError as exc:
                    errors.append({"code": "RIG_CONFIG_ERROR", "file": rel_p, "message": str(exc)})
                    continue

            rendered = dump_unity_meta(target_meta)
            if not dry_run:
                atomic_write_text(meta_path, rendered)
                if recovered_old_rel:
                    old_meta_p = root / f"{recovered_old_rel}.meta"
                    if old_meta_p.exists():
                        old_meta_p.unlink()
                    cache.remove_entry(recovered_old_rel)
                cache.set_entry(
                    rel_p,
                    sha256=sha256,
                    size_bytes=fsize,
                    guid=recovered_guid,
                    analysis=analysis,
                )

            used_guids[recovered_guid] = meta_rel_path
            if recovered_old_rel:
                migrated_files.append(
                    {
                        "from_fbx": recovered_old_rel,
                        "to_fbx": rel_p,
                        "meta": meta_rel_path,
                        "guid": recovered_guid,
                    }
                )
            else:
                generated_files.append(meta_rel_path)
            continue

        # Case 3: Brand-new FBX asset -> Generate deterministic GUID
        candidate_guid = generate_deterministic_guid(rel_p, namespace_uuid=guid_ns)
        collision_idx = 0
        while candidate_guid in used_guids and used_guids[candidate_guid] != meta_rel_path:
            collision_idx += 1
            analysis["warnings"].append(
                f"Deterministic GUID '{candidate_guid}' collided with '{used_guids[candidate_guid]}'; "
                f"applying deterministic collision salt #{collision_idx}."
            )
            candidate_guid = generate_deterministic_guid(
                rel_p, namespace_uuid=guid_ns, salt=f"collision-{collision_idx}"
            )

        try:
            new_meta, build_warnings = build_model_importer_meta(
                guid=candidate_guid,
                fbx_path=fbx_path,
                analysis=analysis,
                importer_settings=importer_settings,
                animation_rules=animation_rules,
            )
            analysis["warnings"].extend(build_warnings)
        except ValueError as exc:
            errors.append({"code": "RIG_CONFIG_ERROR", "file": rel_p, "message": str(exc)})
            continue

        rendered = dump_unity_meta(new_meta)
        if not dry_run:
            atomic_write_text(meta_path, rendered)
            cache.set_entry(
                rel_p,
                sha256=sha256,
                size_bytes=fsize,
                guid=candidate_guid,
                analysis=analysis,
            )

        used_guids[candidate_guid] = meta_rel_path
        generated_files.append(meta_rel_path)

    # Clean up orphaned `.meta` files inside `animations/` after deleted FBX files
    for meta_file in discover_meta_files(anim_dir):
        meta_rel = normalize_rel_path(meta_file, root)
        target_asset = fbx_path_for_meta(meta_file)
        if not target_asset.exists():
            if clean_orphans:
                if not dry_run and meta_file.exists():
                    meta_file.unlink()
                if meta_rel not in consumed_orphan_metas:
                    removed_orphaned_meta.append(meta_rel)
                target_rel = normalize_rel_path(target_asset, root)
                if not dry_run:
                    cache.remove_entry(target_rel)

    # Prune stale deleted entries from cache
    if not dry_run:
        stale_keys = [k for k in list(cache.assets.keys()) if not (root / k).exists()]
        for sk in stale_keys:
            cache.remove_entry(sk)
        cache.save()

    analysis_report_payload = {
        "schema_version": 1,
        "total_fbx_files": len(all_fbx_files),
        "valid_fbx_files": sum(1 for a in analysis_results if a.get("is_valid")),
        "invalid_fbx_files": len(invalid_files),
        "files": analysis_results,
    }

    generation_report = {
        "schema_version": 1,
        "mode": "incremental" if incremental_targets is not None else "full",
        "dry_run": dry_run,
        "total_fbx_files": len(all_fbx_files),
        "analyzed_files": len(analysis_results),
        "generated_metadata_files": len(generated_files),
        "updated_metadata_files": len(updated_files),
        "migrated_renamed_files": len(migrated_files),
        "existing_metadata_files_preserved": len(preserved_files),
        "removed_orphaned_metadata_files": len(removed_orphaned_meta),
        "invalid_fbx_files": len(invalid_files),
        "error_count": len(errors),
        "generated": generated_files,
        "updated": updated_files,
        "migrated": migrated_files,
        "preserved": preserved_files,
        "removed_orphaned": removed_orphaned_meta,
        "invalid": invalid_files,
        "errors": errors,
    }

    if not dry_run:
        rep_dir.mkdir(parents=True, exist_ok=True)
        write_json_report(rep_dir / "analysis_report.json", analysis_report_payload)
        write_json_report(rep_dir / "generation_report.json", generation_report)

    return generation_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate and maintain Unity ModelImporter .meta files for FBX animations."
    )
    parser.add_argument("--repo-root", default=".", help="Repository root directory")
    parser.add_argument("--animations-dir", default=None, help="Animations directory (default: <repo>/animations)")
    parser.add_argument("--importer-settings", default=None, help="Path to importer_settings.json")
    parser.add_argument("--animation-rules", default=None, help="Path to animation_rules.json")
    parser.add_argument("--cache-path", default=None, help="Path to incremental asset cache JSON")
    parser.add_argument("--reports-dir", default=None, help="Directory for JSON reports")
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Process only Git-changed or un-metadata'd FBX assets when possible",
    )
    parser.add_argument(
        "--base-ref",
        default=None,
        help="Optional Git base commit SHA/ref for diff & rename detection",
    )
    parser.add_argument(
        "--reconfigure",
        action="store_true",
        help="Re-apply config importer settings to existing .meta files while preserving GUIDs",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate metadata generation without writing files",
    )
    parser.add_argument(
        "--use-blender",
        action="store_true",
        help="Enable optional headless Blender inspection when available",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return non-zero exit code if any invalid FBX or GUID conflict was encountered",
    )
    args = parser.parse_args(argv)

    report = generate_metadata_pipeline(
        repo_root=args.repo_root,
        animations_dir=args.animations_dir,
        importer_settings_path=args.importer_settings,
        animation_rules_path=args.animation_rules,
        cache_path=args.cache_path,
        reports_dir=args.reports_dir,
        incremental=args.incremental,
        base_ref=args.base_ref,
        reconfigure_existing=args.reconfigure,
        dry_run=args.dry_run,
        use_blender=args.use_blender,
    )

    print(
        f"FBX Metadata Generation ({report['mode']}): "
        f"total={report['total_fbx_files']}, "
        f"generated={report['generated_metadata_files']}, "
        f"updated={report['updated_metadata_files']}, "
        f"migrated={report['migrated_renamed_files']}, "
        f"preserved={report['existing_metadata_files_preserved']}, "
        f"orphans_removed={report['removed_orphaned_metadata_files']}, "
        f"errors={report['error_count']}"
    )

    if args.strict and report["error_count"] > 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
