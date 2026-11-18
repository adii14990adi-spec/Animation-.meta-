#!/usr/bin/env python3
"""Optional Unity Editor Batch-Mode Import & Avatar Validation Stage.

Why this exists:
A `.meta` file alone cannot guarantee runtime Humanoid Avatar T-pose mapping or
muscle retargeting quality—only Unity's native `ModelImporter` + `AvatarBuilder`
can validate T-pose bone transforms and retargeting constraints.

Behavior:
- Never assumes Unity Editor, a Unity license, or the main game project exists.
- When `UNITY_EDITOR_PATH` (or `--unity-editor`) is absent, cleanly reports
  `status="skipped_unavailable"` so callers can clearly distinguish static
  serialization validation from full Unity Editor import validation.
- When a compatible Unity Editor binary IS provided, stages the `.fbx` + `.meta`
  pairs into an isolated temporary Unity project (or user-provided project),
  executes `FbxMetaBatchValidator.Run` in `-batchmode -nographics -quit`, and
  collects real `ModelImporter` / `Avatar` diagnostics.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

UNITY_BATCH_VALIDATOR_CS = r"""using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

public static class FbxMetaBatchValidator
{
    [Serializable]
    public class AssetValidationEntry
    {
        public string assetPath;
        public string expectedGuid;
        public string importedGuid;
        public int animationType;
        public bool avatarValid;
        public bool avatarIsHuman;
        public int clipCount;
        public string rigImportErrors;
        public string rigImportWarnings;
        public string animationImportErrors;
        public string animationImportWarnings;
        public string animationRetargetingWarnings;
        public bool passed;
    }

    [Serializable]
    public class BatchValidationResult
    {
        public string unityVersion;
        public int checkedCount;
        public int failedCount;
        public List<AssetValidationEntry> entries = new List<AssetValidationEntry>();
    }

    public static void Run()
    {
        string outputPath = Environment.GetEnvironmentVariable("FBX_META_UNITY_REPORT_PATH");
        if (string.IsNullOrEmpty(outputPath))
        {
            outputPath = Path.Combine(Directory.GetCurrentDirectory(), "unity_batch_report.json");
        }

        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);

        var result = new BatchValidationResult
        {
            unityVersion = Application.unityVersion,
            checkedCount = 0,
            failedCount = 0
        };

        string[] guids = AssetDatabase.FindAssets("", new[] { "Assets/ValidationStaging" });
        var visitedPaths = new HashSet<string>();

        foreach (string guid in guids)
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            if (string.IsNullOrEmpty(path) || !path.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase))
                continue;
            if (!visitedPaths.Add(path))
                continue;

            result.checkedCount++;
            var importer = AssetImporter.GetAtPath(path) as ModelImporter;
            var entry = new AssetValidationEntry
            {
                assetPath = path,
                importedGuid = guid.ToLowerInvariant(),
                passed = true
            };

            if (importer == null)
            {
                entry.rigImportErrors = "Failed to acquire ModelImporter for asset.";
                entry.passed = false;
                result.failedCount++;
                result.entries.Add(entry);
                continue;
            }

            SerializedObject so = new SerializedObject(importer);
            entry.animationType = (int)importer.animationType;
            entry.rigImportErrors = so.FindProperty("m_RigImportErrors")?.stringValue ?? "";
            entry.rigImportWarnings = so.FindProperty("m_RigImportWarnings")?.stringValue ?? "";
            entry.animationImportErrors = so.FindProperty("m_AnimationImportErrors")?.stringValue ?? "";
            entry.animationImportWarnings = so.FindProperty("m_AnimationImportWarnings")?.stringValue ?? "";
            entry.animationRetargetingWarnings = so.FindProperty("m_AnimationRetargetingWarnings")?.stringValue ?? "";

            UnityEngine.Object[] subAssets = AssetDatabase.LoadAllAssetsAtPath(path);
            Avatar importedAvatar = null;
            int clips = 0;
            foreach (var obj in subAssets)
            {
                if (obj is AnimationClip clip && !clip.name.StartsWith("__preview__", StringComparison.Ordinal))
                    clips++;
                else if (obj is Avatar av)
                    importedAvatar = av;
            }
            entry.clipCount = clips;

            if (importer.animationType == ModelImporterAnimationType.Human &&
                importer.avatarSetup == ModelImporterAvatarSetup.CreateFromThisModel)
            {
                entry.avatarValid = importedAvatar != null && importedAvatar.isValid;
                entry.avatarIsHuman = importedAvatar != null && importedAvatar.isHuman;
                if (!entry.avatarValid || !entry.avatarIsHuman)
                {
                    entry.passed = false;
                }
            }
            else
            {
                entry.avatarValid = true;
                entry.avatarIsHuman = false;
            }

            if (!string.IsNullOrEmpty(entry.rigImportErrors) ||
                !string.IsNullOrEmpty(entry.animationImportErrors) ||
                entry.clipCount == 0)
            {
                entry.passed = false;
            }

            if (!entry.passed)
                result.failedCount++;

            result.entries.Add(entry);
        }

        File.WriteAllText(outputPath, JsonUtility.ToJson(result, true));
        EditorApplication.Exit(result.failedCount == 0 ? 0 : 2);
    }
}
"""


def run_optional_unity_batch_validation(
    *,
    repo_root: Path | str,
    fbx_files: list[Path],
    unity_editor_path: str | None = None,
    unity_project_path: str | None = None,
    timeout_sec: int = 300,
) -> dict[str, Any]:
    """Execute optional Unity Editor `-batchmode` validation when Unity is available."""
    editor_bin = (
        unity_editor_path
        or os.environ.get("UNITY_EDITOR_PATH", "").strip()
        or None
    )

    static_note = (
        "Static validation verified Unity YAML syntax, 32-hex GUID uniqueness/stability, "
        "and authentic ModelImporter serialization schema. Actual Humanoid Avatar T-pose "
        "bone mapping and retargeting validation require Unity Editor batch-mode import."
    )

    if not editor_bin:
        return {
            "status": "skipped_unavailable",
            "executed": False,
            "passed": None,
            "unity_editor_path": None,
            "reason": "No Unity Editor executable configured (UNITY_EDITOR_PATH not set).",
            "static_vs_runtime_note": static_note,
            "checked_assets": 0,
            "errors": [],
            "warnings": [],
        }

    editor_file = Path(editor_bin)
    if not (editor_file.is_file() and os.access(editor_file, os.X_OK)):
        resolved = shutil.which(editor_bin)
        if not resolved:
            return {
                "status": "error_editor_not_found",
                "executed": False,
                "passed": False,
                "unity_editor_path": editor_bin,
                "reason": f"Configured Unity Editor executable does not exist or is not executable: {editor_bin}",
                "static_vs_runtime_note": static_note,
                "checked_assets": 0,
                "errors": [f"Unity Editor binary not found or not executable: {editor_bin}"],
                "warnings": [],
            }
        editor_file = Path(resolved)

    if not fbx_files:
        return {
            "status": "skipped_no_assets",
            "executed": False,
            "passed": True,
            "unity_editor_path": str(editor_file),
            "reason": "No FBX assets present to validate in Unity Editor.",
            "static_vs_runtime_note": static_note,
            "checked_assets": 0,
            "errors": [],
            "warnings": [],
        }

    root = Path(repo_root).resolve()
    temp_root_ctx = tempfile.TemporaryDirectory(prefix="unity_fbx_meta_val_")
    try:
        tmp_base = Path(temp_root_ctx.name)
        if unity_project_path:
            proj_dir = Path(unity_project_path).resolve()
        else:
            proj_dir = tmp_base / "ValidationProject"
            (proj_dir / "Assets").mkdir(parents=True, exist_ok=True)
            (proj_dir / "Packages").mkdir(parents=True, exist_ok=True)
            (proj_dir / "Packages" / "manifest.json").write_text(
                json.dumps({"dependencies": {}}, indent=2) + "\n", encoding="utf-8"
            )

        staging_dir = proj_dir / "Assets" / "ValidationStaging"
        editor_script_dir = proj_dir / "Assets" / "Editor"
        staging_dir.mkdir(parents=True, exist_ok=True)
        editor_script_dir.mkdir(parents=True, exist_ok=True)

        script_path = editor_script_dir / "FbxMetaBatchValidator.cs"
        script_path.write_text(UNITY_BATCH_VALIDATOR_CS, encoding="utf-8")

        staged_count = 0
        for fbx in fbx_files:
            meta = fbx.with_name(f"{fbx.name}.meta")
            if not fbx.exists() or not meta.exists():
                continue
            rel = fbx.resolve().relative_to(root) if fbx.resolve().is_relative_to(root) else Path(fbx.name)
            dest_fbx = staging_dir / rel
            dest_fbx.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(fbx, dest_fbx)
            shutil.copy2(meta, dest_fbx.with_name(f"{dest_fbx.name}.meta"))
            staged_count += 1

        report_json_path = tmp_base / "unity_batch_report.json"
        log_path = tmp_base / "unity_batch.log"

        env = os.environ.copy()
        env["FBX_META_UNITY_REPORT_PATH"] = str(report_json_path)

        cmd = [
            str(editor_file),
            "-batchmode",
            "-nographics",
            "-quit",
            "-projectPath",
            str(proj_dir),
            "-executeMethod",
            "FbxMetaBatchValidator.Run",
            "-logFile",
            str(log_path),
        ]

        proc = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )

        if not report_json_path.exists():
            log_tail = ""
            if log_path.exists():
                log_tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-30:])
            return {
                "status": "failed_execution",
                "executed": True,
                "passed": False,
                "unity_editor_path": str(editor_file),
                "exit_code": proc.returncode,
                "reason": "Unity Editor exited without producing a validation report (check Unity license/activation).",
                "static_vs_runtime_note": static_note,
                "checked_assets": staged_count,
                "errors": [
                    f"Unity batch validation failed with exit code {proc.returncode}. Log tail:\n{log_tail}"
                ],
                "warnings": [],
            }

        unity_data = json.loads(report_json_path.read_text(encoding="utf-8"))
        u_errors: list[str] = []
        u_warnings: list[str] = []
        for entry in unity_data.get("entries", []):
            ap = entry.get("assetPath", "<asset>")
            if not entry.get("passed", False):
                u_errors.append(
                    f"{ap}: rigErrors='{entry.get('rigImportErrors', '')}', "
                    f"animErrors='{entry.get('animationImportErrors', '')}', "
                    f"avatarValid={entry.get('avatarValid')}, clips={entry.get('clipCount')}"
                )
            if entry.get("rigImportWarnings") or entry.get("animationImportWarnings") or entry.get("animationRetargetingWarnings"):
                u_warnings.append(
                    f"{ap}: rigWarnings='{entry.get('rigImportWarnings', '')}', "
                    f"animWarnings='{entry.get('animationImportWarnings', '')}', "
                    f"retargetWarnings='{entry.get('animationRetargetingWarnings', '')}'"
                )

        passed = proc.returncode == 0 and len(u_errors) == 0
        return {
            "status": "passed" if passed else "failed_import_validation",
            "executed": True,
            "passed": passed,
            "unity_editor_path": str(editor_file),
            "unity_version": unity_data.get("unityVersion", ""),
            "checked_assets": int(unity_data.get("checkedCount", staged_count)),
            "static_vs_runtime_note": "Both static serialization and Unity Editor batch-mode import validation were executed.",
            "entries": unity_data.get("entries", []),
            "errors": u_errors,
            "warnings": u_warnings,
        }
    except subprocess.TimeoutExpired:
        return {
            "status": "failed_timeout",
            "executed": True,
            "passed": False,
            "unity_editor_path": str(editor_file),
            "reason": f"Unity Editor batch validation timed out after {timeout_sec}s.",
            "static_vs_runtime_note": static_note,
            "checked_assets": 0,
            "errors": [f"Unity Editor batch validation timed out after {timeout_sec}s."],
            "warnings": [],
        }
    finally:
        # Clean up staged scripts if user supplied a persistent Unity project
        if unity_project_path:
            p_proj = Path(unity_project_path).resolve()
            shutil.rmtree(p_proj / "Assets" / "ValidationStaging", ignore_errors=True)
            s_cs = p_proj / "Assets" / "Editor" / "FbxMetaBatchValidator.cs"
            if s_cs.exists():
                try:
                    s_cs.unlink()
                except OSError:
                    pass
        temp_root_ctx.cleanup()
