"""Tests for Unity GUID generation, determinism, persistence, rename recovery, and collision detection."""

from __future__ import annotations

import shutil
import subprocess
import unicodedata
from pathlib import Path

import pytest

from scripts.generate_meta import generate_metadata_pipeline
from scripts.utils import (
    ZERO_GUID,
    extract_guid_fast,
    generate_deterministic_guid,
    is_valid_unity_guid,
    load_unity_meta,
    scan_repository_guids,
)
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


def test_deterministic_guid_format_and_cross_os_unicode() -> None:
    g1 = generate_deterministic_guid("animations/Run.fbx")
    g2 = generate_deterministic_guid("animations\\Run.fbx")
    assert g1 == g2
    assert is_valid_unity_guid(g1)
    assert len(g1) == 32
    assert g1 != ZERO_GUID

    # macOS NFD vs Linux/Windows NFC Unicode paths must yield the exact same GUID
    nfc_path = unicodedata.normalize("NFC", "animations/Élan_Walk.fbx")
    nfd_path = unicodedata.normalize("NFD", "animations/Élan_Walk.fbx")
    assert generate_deterministic_guid(nfc_path) == generate_deterministic_guid(nfd_path)

    # Different paths must produce distinct GUIDs
    assert generate_deterministic_guid("animations/Walk.fbx") != generate_deterministic_guid(
        "animations/Run.fbx"
    )


def test_invalid_guid_rejection() -> None:
    assert not is_valid_unity_guid("")
    assert not is_valid_unity_guid(None)
    assert not is_valid_unity_guid(ZERO_GUID)
    assert not is_valid_unity_guid("ABCDEF1234567890ABCDEF1234567890")  # uppercase disallowed
    assert not is_valid_unity_guid("abcdef1234567890abcdef123456789")  # 31 chars
    assert not is_valid_unity_guid("abcdef1234567890abcdef12345678901")  # 33 chars
    assert not is_valid_unity_guid("zzzzef1234567890abcdef1234567890")  # non-hex


def test_guid_stability_across_repeated_executions_and_fbx_updates(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    fbx_file = write_fbx(
        ws / "animations" / "Idle.fbx",
        build_synthetic_binary_fbx(takes=[("mixamo.com", 0, 60, 61)]),
    )

    rep1 = generate_metadata_pipeline(repo_root=ws)
    assert rep1["generated_metadata_files"] == 1
    meta_path = fbx_file.with_name("Idle.fbx.meta")
    guid_initial = extract_guid_fast(meta_path)
    assert is_valid_unity_guid(guid_initial)
    mtime_initial = meta_path.stat().st_mtime_ns

    # Second execution with no changes must preserve GUID and not rewrite the .meta file
    rep2 = generate_metadata_pipeline(repo_root=ws)
    assert rep2["generated_metadata_files"] == 0
    assert rep2["updated_metadata_files"] == 0
    assert rep2["existing_metadata_files_preserved"] == 1
    assert extract_guid_fast(meta_path) == guid_initial
    assert meta_path.stat().st_mtime_ns == mtime_initial

    # Re-exporting Idle.fbx in-place with longer frame range must preserve exact GUID
    write_fbx(
        fbx_file,
        build_synthetic_binary_fbx(takes=[("mixamo.com", 0, 90, 91)]),
    )
    rep3 = generate_metadata_pipeline(repo_root=ws)
    assert extract_guid_fast(meta_path) == guid_initial
    updated_meta = load_unity_meta(meta_path)
    assert updated_meta["ModelImporter"]["animations"]["clipAnimations"][0]["lastFrame"] == 90


def test_guid_preserved_on_filesystem_rename_and_distinct_on_copy(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    fbx_bytes = build_synthetic_binary_fbx(
        bone_hierarchy=MIXAMO_HUMANOID_HIERARCHY,
        takes=[("Take 001", 0, 30, 31)],
    )
    old_fbx = write_fbx(ws / "animations" / "Walk.fbx", fbx_bytes)
    generate_metadata_pipeline(repo_root=ws)

    old_meta = ws / "animations" / "Walk.fbx.meta"
    original_guid = extract_guid_fast(old_meta)
    assert is_valid_unity_guid(original_guid)

    # Copy Walk.fbx -> Walk_Copy.fbx while Walk.fbx still exists: must receive a NEW distinct GUID
    copy_fbx = write_fbx(ws / "animations" / "Walk_Copy.fbx", fbx_bytes)
    generate_metadata_pipeline(repo_root=ws)
    copy_guid = extract_guid_fast(ws / "animations" / "Walk_Copy.fbx.meta")
    assert is_valid_unity_guid(copy_guid)
    assert copy_guid != original_guid

    # Remove the copy first so Walk.fbx is unique again, then rename Walk.fbx -> locomotion/Walk_Fwd.fbx
    copy_fbx.unlink()
    (ws / "animations" / "Walk_Copy.fbx.meta").unlink()
    generate_metadata_pipeline(repo_root=ws)

    moved_fbx = ws / "animations" / "locomotion" / "Walk_Fwd.fbx"
    moved_fbx.parent.mkdir(parents=True, exist_ok=True)
    old_fbx.rename(moved_fbx)
    # Leave old Walk.fbx.meta orphaned on disk (common user rename behavior)
    assert old_meta.exists()

    rep_rename = generate_metadata_pipeline(repo_root=ws)
    assert rep_rename["migrated_renamed_files"] == 1
    assert not old_meta.exists()
    new_meta = moved_fbx.with_name("Walk_Fwd.fbx.meta")
    assert new_meta.exists()
    assert extract_guid_fast(new_meta) == original_guid


def test_guid_preserved_on_git_rename_even_when_old_meta_deleted(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    subprocess.run(["git", "init"], cwd=ws, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=ws, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=ws, check=True)

    fbx_a = write_fbx(
        ws / "animations" / "Crate_Open.fbx",
        build_synthetic_binary_fbx(bone_hierarchy=GENERIC_PROP_HIERARCHY, takes=[("Open", 0, 25, 26)]),
    )
    generate_metadata_pipeline(repo_root=ws)
    orig_guid = extract_guid_fast(ws / "animations" / "Crate_Open.fbx.meta")

    subprocess.run(["git", "add", "."], cwd=ws, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=ws, check=True, capture_output=True)
    base_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ws, check=True, capture_output=True, text=True
    ).stdout.strip()

    # Simulate user renaming FBX in Git and deleting old .meta, with cold cache removed
    shutil.rmtree(ws / ".cache", ignore_errors=True)
    subprocess.run(
        ["git", "mv", "animations/Crate_Open.fbx", "animations/SupplyCrate_Open.fbx"],
        cwd=ws,
        check=True,
    )
    subprocess.run(["git", "rm", "animations/Crate_Open.fbx.meta"], cwd=ws, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "rename fbx"], cwd=ws, check=True, capture_output=True)

    rep = generate_metadata_pipeline(repo_root=ws, incremental=True, base_ref=base_sha)
    assert rep["migrated_renamed_files"] == 1
    migrated_guid = extract_guid_fast(ws / "animations" / "SupplyCrate_Open.fbx.meta")
    assert migrated_guid == orig_guid


def test_guid_collision_detection_refuses_silent_reassignment(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    write_fbx(ws / "animations" / "A.fbx", build_synthetic_binary_fbx())
    write_fbx(ws / "animations" / "B.fbx", build_synthetic_binary_fbx())
    generate_metadata_pipeline(repo_root=ws)

    guid_a = extract_guid_fast(ws / "animations" / "A.fbx.meta")
    assert guid_a is not None

    # Force a GUID collision in B.fbx.meta
    b_meta_path = ws / "animations" / "B.fbx.meta"
    b_text = b_meta_path.read_text(encoding="utf-8")
    guid_b = extract_guid_fast(b_meta_path)
    assert guid_b is not None and guid_b != guid_a
    b_meta_path.write_text(b_text.replace(f"guid: {guid_b}", f"guid: {guid_a}"), encoding="utf-8")

    guid_map, _ = scan_repository_guids(ws)
    assert len(guid_map[guid_a]) == 2

    # Generator must report the duplicate existing GUID error and NOT silently overwrite B's GUID
    gen_rep = generate_metadata_pipeline(repo_root=ws)
    assert any(e["code"] == "DUPLICATE_EXISTING_GUID" for e in gen_rep["errors"])
    assert extract_guid_fast(b_meta_path) == guid_a

    # Validator must fail critically on duplicate GUID
    val_rep = validate_repository(repo_root=ws, write_reports=False)
    assert not val_rep["passed"]
    assert val_rep["duplicate_guids"] == 1
    assert any(fc["code"] == "DUPLICATE_GUID" for fc in val_rep["failed_validation_checks"])


def test_accidental_meta_deletion_recovers_legacy_guid_from_git_head(tmp_path: Path) -> None:
    ws = _setup_workspace(tmp_path)
    subprocess.run(["git", "init"], cwd=ws, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=ws, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=ws, check=True)

    write_fbx(ws / "animations" / "LegacyRun.fbx", build_synthetic_binary_fbx())
    generate_metadata_pipeline(repo_root=ws)

    # Set a custom pre-existing Unity GUID in LegacyRun.fbx.meta and commit to Git
    legacy_guid = "9876543210fedcba9876543210fedcba"
    meta_p = ws / "animations" / "LegacyRun.fbx.meta"
    meta_p.write_text(
        meta_p.read_text(encoding="utf-8").replace(
            extract_guid_fast(meta_p), legacy_guid  # type: ignore[arg-type]
        ),
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "."], cwd=ws, check=True)
    subprocess.run(["git", "commit", "-m", "commit legacy guid"], cwd=ws, check=True, capture_output=True)

    # Delete both .cache and LegacyRun.fbx.meta -> pipeline must recover legacy_guid from Git HEAD!
    shutil.rmtree(ws / ".cache", ignore_errors=True)
    meta_p.unlink()

    generate_metadata_pipeline(repo_root=ws)
    assert meta_p.exists()
    assert extract_guid_fast(meta_p) == legacy_guid
    assert validate_repository(repo_root=ws)["passed"] is True

