"""Tests for validation rules, error isolation, orphan cleanup, incremental Git detection, and workflow YAML."""

from __future__ import annotations

import re
import shutil
import struct
import subprocess
from pathlib import Path

import yaml

from scripts.analyze_fbx import FBX_BINARY_MAGIC
from scripts.generate_meta import generate_metadata_pipeline
from scripts.utils import detect_git_fbx_changes, dump_unity_meta, load_unity_meta
from scripts.validate_meta import validate_repository
from tests.fbx_synthetic import (
    GENERIC_PROP_HIERARCHY,
    MIXAMO_HUMANOID_HIERARCHY,
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


def test_missing_and_orphaned_metadata_detection_and_cleanup(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    fbx_walk = write_fbx(ws / "animations" / "Walk.fbx", build_synthetic_binary_fbx())
    fbx_run = write_fbx(ws / "animations" / "Run.fbx", build_synthetic_binary_fbx())

    # Before generation, validator must detect 2 missing .meta files
    val_before = validate_repository(repo_root=ws)
    assert val_before["passed"] is False
    assert val_before["missing_metadata_files"] == 2

    generate_metadata_pipeline(repo_root=ws)
    assert validate_repository(repo_root=ws)["passed"] is True

    # Delete Walk.fbx without deleting Walk.fbx.meta -> validator catches ORPHANED_META
    fbx_walk.unlink()
    val_orphan = validate_repository(repo_root=ws)
    assert val_orphan["passed"] is False
    assert val_orphan["orphaned_metadata_files"] == 1
    assert any(fc["code"] == "ORPHANED_META" for fc in val_orphan["failed_validation_checks"])

    # Re-running generate_metadata_pipeline cleans up orphaned Walk.fbx.meta automatically
    gen_cleanup = generate_metadata_pipeline(repo_root=ws)
    assert gen_cleanup["removed_orphaned_metadata_files"] == 1
    assert not (ws / "animations" / "Walk.fbx.meta").exists()
    assert (ws / "animations" / "Run.fbx.meta").exists()
    assert validate_repository(repo_root=ws)["passed"] is True


def test_invalid_fbx_variants_and_batch_error_isolation(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)

    # 2 valid FBX animations
    write_fbx(ws / "animations" / "Valid_Idle.fbx", build_synthetic_binary_fbx())
    write_fbx(ws / "animations" / "Valid_Jump.fbx", build_synthetic_binary_fbx())

    # 1. Empty 0-byte FBX
    write_fbx(ws / "animations" / "Bad_Empty.fbx", b"")
    # 2. Corrupted header
    write_fbx(ws / "animations" / "Bad_Header.fbx", b"NOT_AN_FBX_BINARY_FILE_1234567890")
    # 3. Truncated binary FBX
    valid_bytes = build_synthetic_binary_fbx()
    write_fbx(ws / "animations" / "Bad_Truncated.fbx", valid_bytes[:64])
    # 4. Unsupported FBX version (v5000)
    write_fbx(
        ws / "animations" / "Bad_Version.fbx",
        FBX_BINARY_MAGIC + struct.pack("<I", 5000) + b"\x00" * 32,
    )
    # 5. Unresolved Git LFS pointer
    write_fbx(
        ws / "animations" / "Bad_LFS.fbx",
        "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 12345\n",
    )
    # 6. Static character mesh upload without animation data (violates scope)
    write_fbx(
        ws / "animations" / "Bad_StaticCharacterMesh.fbx",
        build_synthetic_binary_fbx(takes=[], include_mesh=True),
    )
    # 7. Truncated ASCII FBX (unclosed brace)
    write_fbx(
        ws / "animations" / "Bad_Ascii.fbx",
        "; FBX 7.4.0 project file\nFBXHeaderExtension: {\n\tFBXVersion: 7400\n",
    )

    gen_rep = generate_metadata_pipeline(repo_root=ws)
    # Valid animations MUST still get valid .meta files (error isolation!)
    assert gen_rep["generated_metadata_files"] == 2
    assert (ws / "animations" / "Valid_Idle.fbx.meta").exists()
    assert (ws / "animations" / "Valid_Jump.fbx.meta").exists()
    # Invalid files must NOT receive bogus .meta files
    assert gen_rep["invalid_fbx_files"] == 7
    assert not (ws / "animations" / "Bad_Empty.fbx.meta").exists()
    assert not (ws / "animations" / "Bad_StaticCharacterMesh.fbx.meta").exists()

    val_rep = validate_repository(repo_root=ws)
    assert val_rep["passed"] is False
    assert val_rep["invalid_fbx_files"] == 7
    codes = {fc["code"] for fc in val_rep["failed_validation_checks"]}
    assert "EMPTY_FILE" in codes
    assert "INVALID_FBX_HEADER" in codes
    assert "CORRUPTED_FBX" in codes
    assert "UNSUPPORTED_FBX_VERSION" in codes
    assert "GIT_LFS_POINTER" in codes
    assert "NO_ANIMATION_DATA" in codes


def test_rejects_invented_json_scene_headers_corrupted_meta_and_bad_rig(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    fbx_1 = write_fbx(ws / "animations" / "One.fbx", build_synthetic_binary_fbx())
    fbx_2 = write_fbx(ws / "animations" / "Two.fbx", build_synthetic_binary_fbx())
    fbx_3 = write_fbx(
        ws / "animations" / "GenericCrate.fbx",
        build_synthetic_binary_fbx(bone_hierarchy=GENERIC_PROP_HIERARCHY),
    )
    generate_metadata_pipeline(repo_root=ws)

    # 1. Overwrite One.fbx.meta with JSON renamed to .meta -> must fail!
    (ws / "animations" / "One.fbx.meta").write_text(
        '{"fileFormatVersion": 2, "guid": "11111111111111111111111111111111"}',
        encoding="utf-8",
    )

    # 2. Overwrite Two.fbx.meta with %YAML 1.1 scene header -> must fail!
    (ws / "animations" / "Two.fbx.meta").write_text(
        "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1040 &1\n",
        encoding="utf-8",
    )

    # 3. Force GenericCrate.fbx.meta to Humanoid (animationType=3) + corrupted octal bodyMask + inverted frames
    crate_meta_p = ws / "animations" / "GenericCrate.fbx.meta"
    cm = load_unity_meta(crate_meta_p)
    cm["ModelImporter"]["animationType"] = 3
    cm["ModelImporter"]["avatarSetup"] = 2  # CopyFromOther with {instanceID: 0} -> invalid!
    cm["ModelImporter"]["animations"]["clipAnimations"][0]["bodyMask"] = 123456789
    cm["ModelImporter"]["animations"]["clipAnimations"][0]["firstFrame"] = 50
    cm["ModelImporter"]["animations"]["clipAnimations"][0]["lastFrame"] = 10
    crate_meta_p.write_text(dump_unity_meta(cm), encoding="utf-8")

    val = validate_repository(repo_root=ws)
    assert val["passed"] is False
    codes = {fc["code"] for fc in val["failed_validation_checks"]}
    assert "INVALID_META_SYNTAX" in codes
    assert "INCOMPATIBLE_HUMANOID_RIG" in codes
    assert "INVALID_AVATAR_SOURCE_PPTR" in codes
    assert "INVALID_CLIP_BODY_MASK" in codes
    assert "INVERTED_CLIP_FRAME_RANGE" in codes


def test_guid_instability_against_git_head_and_incremental_detection(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    subprocess.run(["git", "init"], cwd=ws, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=ws, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=ws, check=True)

    write_fbx(ws / "animations" / "Idle.fbx", build_synthetic_binary_fbx( bone_hierarchy=MIXAMO_HUMANOID_HIERARCHY))
    generate_metadata_pipeline(repo_root=ws)
    subprocess.run(["git", "add", "."], cwd=ws, check=True)
    subprocess.run(["git", "commit", "-m", "initial meta"], cwd=ws, check=True, capture_output=True)

    # Add a new FBX in working tree -> detect_git_fbx_changes & incremental mode must spot only Walk.fbx
    write_fbx(ws / "animations" / "Walk.fbx", build_synthetic_binary_fbx())
    changes = detect_git_fbx_changes(ws)
    assert "animations/Walk.fbx" in changes.added_or_modified
    assert "animations/Idle.fbx" not in changes.added_or_modified

    inc_rep = generate_metadata_pipeline(repo_root=ws, incremental=True)
    assert inc_rep["mode"] == "incremental"
    assert inc_rep["generated_metadata_files"] == 1
    assert inc_rep["existing_metadata_files_preserved"] == 1
    assert validate_repository(repo_root=ws)["passed"] is True

    # Mutate Idle.fbx.meta's GUID -> validator must flag GUID_INSTABILITY against Git HEAD!
    idle_meta_p = ws / "animations" / "Idle.fbx.meta"
    idle_meta = load_unity_meta(idle_meta_p)
    idle_meta["guid"] = "ffffffffffffffffffffffffffffffff"
    idle_meta_p.write_text(dump_unity_meta(idle_meta), encoding="utf-8")

    val = validate_repository(repo_root=ws)
    assert val["passed"] is False
    assert any(fc["code"] == "GUID_INSTABILITY" for fc in val["failed_validation_checks"])
    # Also verify static_only mode is clearly reported when Unity Editor is unavailable
    assert val["validation_mode"] == "static_only"
    assert val["unity_editor_validation"]["status"] == "skipped_unavailable"


def test_github_actions_workflow_yaml_security_and_structure() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    wf_path = repo_root / ".github" / "workflows" / "generate-animation-meta.yml"
    assert wf_path.exists()

    wf = yaml.safe_load(wf_path.read_text(encoding="utf-8"))
    # PyYAML 1.1 maps bare `on` key to True unless quoted; support either `on` or `True`
    triggers = wf.get("on") or wf.get(True)
    assert isinstance(triggers, dict)
    assert "push" in triggers
    assert "workflow_dispatch" in triggers
    push_paths = triggers["push"]["paths"]
    assert any("animations/" in p and "fbx" in p.lower() for p in push_paths)

    # Top-level minimal read permission + concurrency
    assert wf["permissions"] == {"contents": "read"}
    assert "concurrency" in wf
    assert wf["concurrency"]["cancel-in-progress"] is False

    job = wf["jobs"]["generate-and-validate-meta"]
    assert job["permissions"] == {"contents": "write"}
    assert "github-actions[bot]" in job["if"]
    assert "[skip ci]" in job["if"]

    # Every third-party `uses:` step MUST be pinned to a full 40-char hex commit SHA
    sha_pin_re = re.compile(r"^[^@]+@[0-9a-f]{40}$")
    uses_steps = [s["uses"] for s in job["steps"] if "uses" in s]
    assert len(uses_steps) >= 3
    for u in uses_steps:
        assert sha_pin_re.match(u), f"Unpinned GitHub Action reference: {u}"


def test_cli_entrypoints_and_nonexistent_unity_editor_error(tmp_path: Path) -> None:
    from scripts.analyze_fbx import main as analyze_main
    from scripts.generate_meta import main as generate_main
    from scripts.validate_meta import main as validate_main

    ws = _setup_workspace(tmp_path)
    write_fbx(ws / "animations" / "Aim_Loop.fbx", build_synthetic_binary_fbx())

    assert analyze_main([str(ws / "animations"), "--repo-root", str(ws)]) == 0
    assert generate_main(["--repo-root", str(ws), "--strict"]) == 0
    assert validate_main(["--repo-root", str(ws)]) == 0

    # Unrelated non-FBX file (e.g. .glb/.obj preview) emits a warning without blocking FBX .meta validation,
    # whereas a non-FBX .meta inside animations/ fails validation critically.
    (ws / "animations" / "showcase_all.glb").write_bytes(b"glTF")
    rep_non_fbx = validate_repository(repo_root=ws)
    assert rep_non_fbx["passed"] is True
    assert any(w["code"] == "IGNORED_NON_FBX_FILE" for w in rep_non_fbx["warnings"])

    (ws / "animations" / "showcase_all.glb.meta").write_text(
        "fileFormatVersion: 2\nguid: 11111111111111111111111111111111\n", encoding="utf-8"
    )
    assert validate_main(["--repo-root", str(ws)]) == 1
    (ws / "animations" / "showcase_all.glb.meta").unlink()
    (ws / "animations" / "showcase_all.glb").unlink()

    # Explicitly specifying a missing Unity Editor binary must fail cleanly
    assert (
        validate_main(
            [
                "--repo-root",
                str(ws),
                "--unity-editor",
                "/nonexistent/path/to/Unity",
            ]
        )
        == 1
    )

