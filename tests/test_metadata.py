"""Tests for FBX inspection, Unity ModelImporter serialization, rig classification, and batch processing."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from scripts.analyze_fbx import analyze_fbx_file
from scripts.generate_meta import generate_metadata_pipeline
from scripts.utils import (
    DEFAULT_HUMANOID_BODY_MASK,
    dump_unity_meta,
    load_unity_meta,
    parse_unity_meta_text,
)
from scripts.validate_meta import validate_repository
from tests.fbx_synthetic import (
    GENERIC_PROP_HIERARCHY,
    MIXAMO_HUMANOID_HIERARCHY,
    build_synthetic_ascii_fbx,
    build_synthetic_binary_fbx,
    write_fbx,
)


def _setup_workspace(tmp_path: Path) -> Path:
    repo_root = Path(__file__).resolve().parent.parent
    ws = tmp_path / "repo"
    (ws / "animations").mkdir(parents=True)
    (ws / "config").mkdir(parents=True)
    (ws / "reports").mkdir(parents=True)
    shutil.copy2(repo_root / "config" / "importer_settings.json", ws / "config" / "importer_settings.json")
    shutil.copy2(repo_root / "config" / "animation_rules.json", ws / "config" / "animation_rules.json")
    return ws


def test_unity_meta_yaml_roundtrip_avoids_octal_float_and_boolean_traps() -> None:
    # Edge-case GUID with scientific-notation-looking 'e' and leading zeros
    tricky_guid = "0012345678901234567890e123456789"
    sample_text = f"""fileFormatVersion: 2
guid: {tricky_guid}
ModelImporter:
  serializedVersion: 21202
  internalIDToNameTable:
  - first:
      74: -6239216113759591374
    second: Off
  externalObjects: {{}}
  materials:
    materialImportMode: 0
    materialName: 0
    materialSearch: 1
    materialLocation: 1
  animations:
    legacyGenerateAnimations: 4
    resampleCurves: 1
    animationCompression: 3
    clipAnimations:
    - serializedVersion: 16
      name: Off
      takeName: Take 001
      internalID: -6239216113759591374
      firstFrame: 0
      lastFrame: 30
      loopTime: 1
      loopBlend: 1
      loopBlendOrientation: 0
      loopBlendPositionY: 1
      loopBlendPositionXZ: 0
      keepOriginalOrientation: 1
      keepOriginalPositionY: 1
      keepOriginalPositionXZ: 1
      heightFromFeet: 0
      mirror: 0
      hasAdditiveReferencePose: 0
      bodyMask: {DEFAULT_HUMANOID_BODY_MASK}
      curves: []
      events: []
      transformMask: []
      maskType: 3
      maskSource: {{instanceID: 0}}
      additiveReferencePoseFrame: 0
  meshes:
    globalScale: 1
    meshCompression: 0
    fileIdsGeneration: 2
  tangentSpace:
    normalSmoothAngle: 60
  referencedClips: []
  importAnimation: 1
  humanDescription:
    serializedVersion: 3
    human: []
    skeleton: []
  lastHumanDescriptionAvatarSource: {{instanceID: 0}}
  autoGenerateAvatarMappingIfUnspecified: 1
  animationType: 3
  avatarSetup: 1
  userData: 
  assetBundleName: 
  assetBundleVariant: 
AssetOrigin:
  serializedVersion: 1
  packageName: SamplePack
"""
    parsed = parse_unity_meta_text(sample_text)
    assert parsed["guid"] == tricky_guid
    assert isinstance(parsed["guid"], str)

    clip = parsed["ModelImporter"]["animations"]["clipAnimations"][0]
    # Must remain string "Off", NOT Python bool False!
    assert clip["name"] == "Off"
    # Must remain 104-char hex string, NOT YAML 1.1 octal integer!
    assert clip["bodyMask"] == DEFAULT_HUMANOID_BODY_MASK
    assert clip["internalID"] == -6239216113759591374
    assert parsed["ModelImporter"]["userData"] == ""
    assert parsed["AssetOrigin"]["packageName"] == "SamplePack"

    dumped = dump_unity_meta(parsed)
    lines = dumped.splitlines()
    assert lines[0] == "fileFormatVersion: 2"
    assert lines[1] == f"guid: {tricky_guid}"
    assert lines[2] == "ModelImporter:"
    assert "lastHumanDescriptionAvatarSource: {instanceID: 0}" in dumped
    assert f"bodyMask: {DEFAULT_HUMANOID_BODY_MASK}" in dumped
    assert "userData: null" not in dumped
    assert "  userData: " in dumped


def test_fbx_analysis_binary_32bit_64bit_and_ascii(tmp_path: Path) -> None:
    # 1. Binary 7400 (32-bit offsets) with mesh + humanoid + 30fps
    b74 = write_fbx(
        tmp_path / "Soldier@Run.fbx",
        build_synthetic_binary_fbx(
            version=7400,
            fps=30.0,
            time_mode=6,
            bone_hierarchy=MIXAMO_HUMANOID_HIERARCHY,
            takes=[("T-Pose", 0, 0, 0), ("mixamo.com", 0, 24, 25)],
            include_mesh=True,
        ),
    )
    r74 = analyze_fbx_file(b74, repo_root=tmp_path)
    assert r74["is_valid"] is True
    assert r74["fbx_format"] == "binary"
    assert r74["fbx_version"] == 7400
    assert r74["frame_rate"] == 30.0
    assert r74["has_animation"] is True
    assert r74["has_mesh"] is True
    assert r74["total_vertex_count"] == 4
    assert r74["has_skeleton"] is True
    assert r74["rig_classification"]["rig_type"] == "Humanoid"
    assert r74["rig_classification"]["has_extra_root"] is True

    # 2. Binary 7500 (64-bit offsets) with custom 60fps + generic rig
    b75 = write_fbx(
        tmp_path / "Weapon_Reload.fbx",
        build_synthetic_binary_fbx(
            version=7500,
            fps=60.0,
            time_mode=13,
            bone_hierarchy=GENERIC_PROP_HIERARCHY,
            takes=[("Reload_Full", 0, 120, 61)],
            include_mesh=False,
        ),
    )
    r75 = analyze_fbx_file(b75, repo_root=tmp_path)
    assert r75["is_valid"] is True
    assert r75["fbx_version"] == 7500
    assert r75["frame_rate"] == 60.0
    assert r75["primary_duration_sec"] == 2.0
    assert r75["total_frame_count"] == 120
    assert r75["has_mesh"] is False
    assert r75["rig_classification"]["rig_type"] == "Generic"

    # 3. ASCII FBX 7400 at 24fps
    asc = write_fbx(
        tmp_path / "Cinema_Idle.fbx",
        build_synthetic_ascii_fbx(version=7400, fps=24.0, time_mode=10, start_frame=0, end_frame=48),
    )
    rasc = analyze_fbx_file(asc, repo_root=tmp_path)
    assert rasc["is_valid"] is True
    assert rasc["fbx_format"] == "ascii"
    assert rasc["frame_rate"] == 24.0
    assert rasc["primary_duration_sec"] == 2.0
    assert rasc["rig_classification"]["rig_type"] == "Humanoid"


def test_humanoid_generic_unknown_rig_and_category_rules(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)

    # 1. Humanoid looping Sprint (`Soldier@Sprint.fbx` -> clip name `Sprint`, loopTime=1, animationType=3)
    write_fbx(
        ws / "animations" / "Soldier@Sprint.fbx",
        build_synthetic_binary_fbx(
            bone_hierarchy=MIXAMO_HUMANOID_HIERARCHY,
            takes=[("T-Pose", 0, 0, 0), ("mixamo.com", 0, 18, 19)],
            include_mesh=True,
        ),
    )
    # 2. Humanoid one-shot Reload (`Rifle_Reload.fbx` -> loopTime=0, animationType=3)
    write_fbx(
        ws / "animations" / "Rifle_Reload.fbx",
        build_synthetic_binary_fbx(
            bone_hierarchy=MIXAMO_HUMANOID_HIERARCHY,
            takes=[("Take 001", 0, 75, 76)],
        ),
    )
    # 3. Generic prop animation (`SupplyCrate_Open.fbx` -> animationType=2 Generic, NOT Humanoid!)
    write_fbx(
        ws / "animations" / "SupplyCrate_Open.fbx",
        build_synthetic_binary_fbx(
            bone_hierarchy=GENERIC_PROP_HIERARCHY,
            takes=[("OpenCrate", 0, 40, 41)],
        ),
    )
    # 4. Unknown rig (0 bones, animated curve only -> fallback Generic with avatarSetup=0 NoAvatar)
    write_fbx(
        ws / "animations" / "FloatingObject.fbx",
        build_synthetic_binary_fbx(
            bone_hierarchy=[],
            takes=[("FloatAnim", 0, 20, 21)],
        ),
    )

    rep = generate_metadata_pipeline(repo_root=ws)
    assert rep["generated_metadata_files"] == 4
    assert rep["error_count"] == 0

    sprint_meta = load_unity_meta(ws / "animations" / "Soldier@Sprint.fbx.meta")
    assert sprint_meta["ModelImporter"]["animationType"] == 3
    assert sprint_meta["ModelImporter"]["avatarSetup"] == 1
    assert sprint_meta["ModelImporter"]["materials"]["materialImportMode"] == 0
    assert sprint_meta["ModelImporter"]["meshes"]["importBlendShapes"] == 0
    sprint_clips = sprint_meta["ModelImporter"]["animations"]["clipAnimations"]
    assert len(sprint_clips) == 1  # T-Pose helper take filtered out
    assert sprint_clips[0]["name"] == "Sprint"
    assert sprint_clips[0]["loopTime"] == 1
    assert sprint_clips[0]["loopBlend"] == 1
    assert sprint_clips[0]["heightFromFeet"] == 1

    reload_meta = load_unity_meta(ws / "animations" / "Rifle_Reload.fbx.meta")
    assert reload_meta["ModelImporter"]["animationType"] == 3
    assert reload_meta["ModelImporter"]["animations"]["clipAnimations"][0]["loopTime"] == 0

    crate_meta = load_unity_meta(ws / "animations" / "SupplyCrate_Open.fbx.meta")
    assert crate_meta["ModelImporter"]["animationType"] == 2  # Generic!

    unknown_meta = load_unity_meta(ws / "animations" / "FloatingObject.fbx.meta")
    assert unknown_meta["ModelImporter"]["animationType"] == 2
    assert unknown_meta["ModelImporter"]["avatarSetup"] == 0  # NoAvatar

    val_rep = validate_repository(repo_root=ws)
    assert val_rep["passed"] is True


def test_copy_from_other_avatar_and_asset_overrides(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    external_avatar_guid = "a1b2c3d4e5f60718293a4b5c6d7e8f90"

    rules_path = ws / "config" / "animation_rules.json"
    rules = json.loads(rules_path.read_text(encoding="utf-8"))
    rules["asset_overrides"]["animations/CustomKick.fbx"] = {
        "category": "Melee",
        "avatar_setup": "CopyFromOther",
        "source_avatar_guid": external_avatar_guid,
        "source_avatar_file_id": 9000000,
        "first_frame": 5,
        "last_frame": 28,
        "loop_time": False,
    }
    rules_path.write_text(json.dumps(rules, indent=2), encoding="utf-8")

    write_fbx(
        ws / "animations" / "CustomKick.fbx",
        build_synthetic_binary_fbx(takes=[("Take 001", 0, 35, 36)]),
    )
    generate_metadata_pipeline(repo_root=ws)

    meta = load_unity_meta(ws / "animations" / "CustomKick.fbx.meta")
    mi = meta["ModelImporter"]
    assert mi["animationType"] == 3
    assert mi["avatarSetup"] == 2
    assert mi["lastHumanDescriptionAvatarSource"] == {
        "fileID": 9000000,
        "guid": external_avatar_guid,
        "type": 3,
    }
    clip = mi["animations"]["clipAnimations"][0]
    assert clip["firstFrame"] == 5
    assert clip["lastFrame"] == 28
    assert validate_repository(repo_root=ws)["passed"] is True


def test_existing_custom_unity_metadata_preserved(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    fbx_p = write_fbx(ws / "animations" / "Jump.fbx", build_synthetic_binary_fbx())
    generate_metadata_pipeline(repo_root=ws)

    meta_p = fbx_p.with_name("Jump.fbx.meta")
    meta_data = load_unity_meta(meta_p)
    original_guid = meta_data["guid"]
    # Simulate Unity Editor customization (custom userData, events, internalIDToNameTable)
    meta_data["ModelImporter"]["userData"] = "custom-studio-tag"
    meta_data["ModelImporter"]["internalIDToNameTable"] = [
        {"first": {74: 1827226128182048838}, "second": "Jump"}
    ]
    meta_p.write_text(dump_unity_meta(meta_data), encoding="utf-8")

    rep = generate_metadata_pipeline(repo_root=ws)
    assert rep["existing_metadata_files_preserved"] == 1
    assert rep["updated_metadata_files"] == 0

    after = load_unity_meta(meta_p)
    assert after["guid"] == original_guid
    assert after["ModelImporter"]["userData"] == "custom-studio-tag"
    assert after["ModelImporter"]["internalIDToNameTable"] == [
        {"first": {74: 1827226128182048838}, "second": "Jump"}
    ]


def test_special_filenames_and_batch_120_fbx_performance(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    fbx_payload = build_synthetic_binary_fbx(takes=[("mixamo.com", 0, 30, 31)])

    tricky_names = [
        "Crouch Walk (Aim) #1.fbx",
        "걷기_Walk_日本語_Élan.fbx",
        "Hero@Hit_Reaction-Front's.fbx",
    ]
    for tname in tricky_names:
        write_fbx(ws / "animations" / "special" / tname, fbx_payload)

    for i in range(120):
        sub = "locomotion" if i % 2 == 0 else "combat"
        write_fbx(ws / "animations" / sub / f"Anim_{i:03d}_Run.fbx", fbx_payload)

    rep1 = generate_metadata_pipeline(repo_root=ws)
    assert rep1["total_fbx_files"] == 123
    assert rep1["generated_metadata_files"] == 123
    assert rep1["error_count"] == 0

    val_rep = validate_repository(repo_root=ws)
    assert val_rep["passed"] is True
    assert val_rep["total_fbx_files"] == 123

    # Re-run: all 123 files must be preserved with 0 rewrites
    rep2 = generate_metadata_pipeline(repo_root=ws)
    assert rep2["generated_metadata_files"] == 0
    assert rep2["updated_metadata_files"] == 0
    assert rep2["existing_metadata_files_preserved"] == 123
