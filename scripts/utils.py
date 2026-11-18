#!/usr/bin/env python3
"""Shared utilities for Unity FBX animation metadata generation and validation.

Provides:
- Cross-platform Unicode-safe (NFC) path normalization
- Deterministic Unity GUID generation, validation, and collision scanning
- Authentic Unity `.meta` YAML parser and serializer (avoiding PyYAML octal/float/bool corruption)
- Incremental SHA-256 asset analysis & GUID persistence cache
- Git change, rename, and historical metadata lookup helpers
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import unicodedata
import uuid
from pathlib import Path
from typing import Any

import yaml

DEFAULT_GUID_NAMESPACE = uuid.UUID("8f5c7b42-3a91-4d8e-b62c-91e7a04f52d1")
VALID_GUID_RE = re.compile(r"^[0-9a-f]{32}$")
ZERO_GUID = "00000000000000000000000000000000"

# 13 int32 little-endian 1s (AvatarMaskBodyPart.LastBodyPart == 13 -> 52 bytes -> 104 hex chars)
DEFAULT_HUMANOID_BODY_MASK = "01000000" * 13
VALID_BODY_MASK_RE = re.compile(r"^[0-9a-fA-F]{104}$")

EXCLUDED_SCAN_DIRS = {
    ".git",
    ".venv",
    "venv",
    ".cache",
    "__pycache__",
    ".pytest_cache",
    ".unity_validation_tmp",
    "node_modules",
}

# Strict scalar patterns for UnityMetaLoader (prevents octal bodyMask & hex GUID float/int mangling)
_STRICT_INT_RE = re.compile(r"^-?(?:0|[1-9][0-9]{0,18})$")
_STRICT_FLOAT_RE = re.compile(
    r"^-?(?:(?:0|[1-9][0-9]*)\.[0-9]+(?:[eE][-+]?[0-9]+)?|(?:0|[1-9][0-9]*)[eE][-+]?[0-9]+)$"
)

# Strings that require quoting when emitting Unity YAML scalars
_NEEDS_YAML_QUOTES_RE = re.compile(
    r"(?:^\s|\s$|^[-?:,[\]{}#&*!|>'"
    r'"%@`]|:\s|\s#|\n|\r|\t|^~$|^null$|^Null$|^NULL$)'
)


# ---------------------------------------------------------------------------
# Path & Filename Helpers
# ---------------------------------------------------------------------------


def normalize_unicode(text: str) -> str:
    """Normalize Unicode strings to NFC for deterministic cross-OS behavior."""
    return unicodedata.normalize("NFC", text)


def normalize_rel_path(path: Path | str, root: Path | str) -> str:
    """Return an NFC-normalized POSIX path relative to `root`."""
    p = Path(path).resolve()
    r = Path(root).resolve()
    rel = p.relative_to(r).as_posix()
    return normalize_unicode(rel)


def is_fbx_file(path: Path | str) -> bool:
    """Return True if `path` has a `.fbx` extension (case-insensitive)."""
    name = Path(path).name
    return name.lower().endswith(".fbx") and not name.startswith(".")


def is_fbx_meta_file(path: Path | str) -> bool:
    """Return True if `path` is a `.fbx.meta` file (case-insensitive `.fbx`)."""
    name = Path(path).name
    return name.lower().endswith(".fbx.meta") and not name.startswith(".")


def meta_path_for_fbx(fbx_path: Path | str) -> Path:
    """Return the sidecar `.meta` path for an FBX file (`<fbx_path>.meta`)."""
    p = Path(fbx_path)
    return p.with_name(f"{p.name}.meta")


def fbx_path_for_meta(meta_path: Path | str) -> Path:
    """Return the asset path corresponding to `<asset_path>.meta`."""
    p = Path(meta_path)
    if not p.name.endswith(".meta"):
        raise ValueError(f"Expected a .meta path, got: {meta_path}")
    return p.with_name(p.name[:-5])


def discover_fbx_files(animations_dir: Path | str) -> list[Path]:
    """Recursively discover all `.fbx` files inside `animations_dir` in deterministic order."""
    base = Path(animations_dir)
    if not base.exists():
        return []
    results: list[Path] = []
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_SCAN_DIRS and not d.startswith("."))
        for fname in sorted(files):
            if fname.lower().endswith(".fbx") and not fname.startswith("."):
                results.append(Path(root) / fname)
    results.sort(key=lambda p: normalize_unicode(p.relative_to(base).as_posix()))
    return results


def discover_meta_files(animations_dir: Path | str) -> list[Path]:
    """Recursively discover all `.meta` files inside `animations_dir` in deterministic order."""
    base = Path(animations_dir)
    if not base.exists():
        return []
    results: list[Path] = []
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_SCAN_DIRS and not d.startswith("."))
        for fname in sorted(files):
            if fname.endswith(".meta") and not fname.startswith("."):
                results.append(Path(root) / fname)
    results.sort(key=lambda p: normalize_unicode(p.relative_to(base).as_posix()))
    return results


def derive_clip_name_from_asset(fbx_path: Path | str, strip_at_prefix: bool = True) -> str:
    """Derive a clean Unity AnimationClip name from an FBX filename.

    Supports Unity's standard `ModelName@ClipName.fbx` convention as well as
    spaces, special characters, and Unicode names.
    """
    stem = normalize_unicode(Path(fbx_path).stem).strip()
    if strip_at_prefix and "@" in stem:
        after_at = stem.split("@", 1)[1].strip()
        if after_at:
            stem = after_at
    return stem or "Clip"


def compute_sha256(file_path: Path | str, chunk_size: int = 65536) -> str:
    """Stream-compute the lowercase hex SHA-256 digest of a file."""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


# ---------------------------------------------------------------------------
# Deterministic GUID Generation & Repository Scanning
# ---------------------------------------------------------------------------


def is_valid_unity_guid(guid: Any) -> bool:
    """Validate that `guid` is a 32-char lowercase hex Unity GUID and not all zeros."""
    return isinstance(guid, str) and bool(VALID_GUID_RE.match(guid)) and guid != ZERO_GUID


def generate_deterministic_guid(
    rel_asset_path: str,
    namespace_uuid: uuid.UUID | str = DEFAULT_GUID_NAMESPACE,
    salt: str = "",
) -> str:
    """Generate a deterministic 32-char lowercase hex Unity GUID for a new asset.

    Strategy:
    - Uses RFC 4122 UUIDv5 over a project namespace UUID and the NFC-normalized
      POSIX repository-relative asset path (e.g. `animations/Run.fbx`).
    - Produces an identical 128-bit lowercase hex identifier across Linux, macOS,
      and Windows without requiring external state.
    """
    ns = uuid.UUID(str(namespace_uuid)) if not isinstance(namespace_uuid, uuid.UUID) else namespace_uuid
    normalized_path = normalize_unicode(rel_asset_path.replace("\\", "/").lstrip("./"))
    seed = f"unity-fbx-asset:{normalized_path}"
    if salt:
        seed = f"{seed}#{salt}"
    digest = uuid.uuid5(ns, seed).hex.lower()
    if digest == ZERO_GUID:
        digest = uuid.uuid5(ns, f"{seed}#nonzero").hex.lower()
    return digest


_FAST_GUID_LINE_RE = re.compile(r"^guid:\s*([^\s#]+)\s*$", re.MULTILINE)


def extract_guid_fast(meta_path: Path | str) -> str | None:
    """Quickly extract the top-level `guid:` string from a `.meta` file."""
    try:
        with open(meta_path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(2048)
    except OSError:
        return None
    m = _FAST_GUID_LINE_RE.search(head)
    if not m:
        return None
    return m.group(1).strip().strip("'\"")


def scan_repository_guids(repo_root: Path | str) -> tuple[dict[str, list[str]], dict[str, str]]:
    """Scan all `.meta` files across `repo_root` for GUIDs and collisions.

    Returns:
        (guid_to_meta_rel_paths, meta_rel_path_to_guid)
    """
    root_path = Path(repo_root).resolve()
    guid_to_paths: dict[str, list[str]] = {}
    path_to_guid: dict[str, str] = {}

    for cur_root, dirs, files in os.walk(root_path):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_SCAN_DIRS)
        for fname in sorted(files):
            if not fname.endswith(".meta") or fname.startswith("."):
                continue
            full_path = Path(cur_root) / fname
            rel_path = normalize_rel_path(full_path, root_path)
            guid = extract_guid_fast(full_path)
            if guid is not None:
                path_to_guid[rel_path] = guid
                guid_to_paths.setdefault(guid, []).append(rel_path)

    return guid_to_paths, path_to_guid


# ---------------------------------------------------------------------------
# Authentic Unity `.meta` YAML Parser & Emitter
# ---------------------------------------------------------------------------


class UnityMetaParseError(ValueError):
    """Raised when a `.meta` file violates Unity YAML serialization syntax."""


class UnityMetaLoader(yaml.SafeLoader):
    """Custom YAML SafeLoader tailored for Unity `.meta` serialization.

    Prevents standard YAML 1.1 pitfalls that corrupt Unity metadata:
    1. Does NOT treat `01000000...` (`bodyMask`) as an octal integer.
    2. Does NOT parse 32-char hex GUIDs like `1234...e12...` or all-digit GUIDs as floats/ints.
    3. Does NOT convert plain strings like `Off`, `On`, `No`, `Yes` into Python booleans.
    4. Maps empty scalars (`userData: `) to `""` rather than `None`.
    """


# Reset default YAML 1.1 implicit resolvers on our subclass only
UnityMetaLoader.yaml_implicit_resolvers = {}


def _construct_unity_scalar(loader: UnityMetaLoader, node: yaml.ScalarNode) -> Any:
    val = loader.construct_scalar(node)
    # Quoted scalars in YAML are always explicit strings
    if node.style in ("'", '"', "|", ">"):
        return val
    if val == "":
        return ""
    if val in ("null", "Null", "NULL", "~"):
        return None
    # Never coerce 32-character hex GUID candidates to int/float
    if len(val) == 32 and VALID_GUID_RE.match(val.lower()):
        return val
    if _STRICT_INT_RE.match(val):
        try:
            return int(val, 10)
        except ValueError:
            return val
    if len(val) < 30 and _STRICT_FLOAT_RE.match(val):
        try:
            fval = float(val)
            if fval != float("inf") and fval != float("-inf"):
                return fval
        except ValueError:
            return val
    return val


UnityMetaLoader.add_constructor("tag:yaml.org,2002:str", _construct_unity_scalar)


def parse_unity_meta_text(text: str, source_name: str = "<meta>") -> dict[str, Any]:
    """Parse Unity `.meta` text strictly, rejecting JSON or `%YAML` scene headers."""
    if not text or not text.strip():
        raise UnityMetaParseError(f"{source_name}: file is empty")

    stripped = text.lstrip("\ufeff").lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        raise UnityMetaParseError(
            f"{source_name}: JSON syntax is not valid Unity .meta serialization"
        )
    if stripped.startswith("%YAML") or stripped.startswith("--- !u!"):
        raise UnityMetaParseError(
            f"{source_name}: Unity .meta files must not use %YAML / --- !u! asset headers"
        )

    try:
        loaded = yaml.load(text, Loader=UnityMetaLoader)
    except yaml.YAMLError as exc:
        raise UnityMetaParseError(f"{source_name}: YAML parse error: {exc}") from exc

    if not isinstance(loaded, dict):
        raise UnityMetaParseError(
            f"{source_name}: expected top-level YAML mapping, got {type(loaded).__name__}"
        )
    return loaded


def load_unity_meta(meta_path: Path | str) -> dict[str, Any]:
    """Read and parse a Unity `.meta` file from disk."""
    p = Path(meta_path)
    try:
        text = p.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise UnityMetaParseError(f"{p}: invalid UTF-8 encoding: {exc}") from exc
    except OSError as exc:
        raise UnityMetaParseError(f"{p}: unable to read file: {exc}") from exc
    return parse_unity_meta_text(text, source_name=str(p))


def is_unity_pptr_dict(value: Any) -> bool:
    """Return True if `value` is a Unity inline Object PPtr reference mapping."""
    if not isinstance(value, dict) or not value:
        return False
    keys = set(value.keys())
    if keys == {"instanceID"}:
        return isinstance(value["instanceID"], int)
    if "fileID" in keys and keys.issubset({"fileID", "guid", "type"}):
        return isinstance(value["fileID"], int)
    # Vector3 / Quaternion inline structs in HumanDescription limits/skeleton if present
    if keys in ({"x", "y", "z"}, {"x", "y", "z", "w"}):
        return all(isinstance(v, (int, float)) for v in value.values())
    return False


def _format_unity_float(value: float) -> str:
    if value == 0.0:
        return "0"
    if value.is_integer() and abs(value) < 1e15:
        return str(int(value))
    formatted = f"{value:.8g}"
    return formatted


def _format_unity_scalar(value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _format_unity_float(value)
    s = str(value)
    if _NEEDS_YAML_QUOTES_RE.search(s):
        # Single-quote YAML style (doubling internal single quotes) unless control chars exist
        if "\n" in s or "\r" in s or "\t" in s or "\x00" in s:
            escaped = (
                s.replace("\\", "\\\\")
                .replace('"', '\\"')
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t")
            )
            return f'"{escaped}"'
        return "'" + s.replace("'", "''") + "'"
    return s


def _format_inline_pptr(mapping: dict[str, Any]) -> str:
    if "instanceID" in mapping and len(mapping) == 1:
        return f"{{instanceID: {mapping['instanceID']}}}"
    if "fileID" in mapping:
        ordered_keys = [k for k in ("fileID", "guid", "type") if k in mapping]
    elif "w" in mapping:
        ordered_keys = ["x", "y", "z", "w"]
    else:
        ordered_keys = ["x", "y", "z"]
    parts = [f"{k}: {_format_unity_scalar(mapping[k])}" for k in ordered_keys]
    return "{" + ", ".join(parts) + "}"


def _emit_mapping_entry(key: Any, val: Any, indent: int, lines: list[str]) -> None:
    pad = " " * indent
    k_str = _format_unity_scalar(key)
    if isinstance(val, dict):
        if not val:
            lines.append(f"{pad}{k_str}: {{}}")
        elif is_unity_pptr_dict(val):
            lines.append(f"{pad}{k_str}: {_format_inline_pptr(val)}")
        else:
            lines.append(f"{pad}{k_str}:")
            for sub_k, sub_v in val.items():
                _emit_mapping_entry(sub_k, sub_v, indent + 2, lines)
    elif isinstance(val, list):
        if not val:
            lines.append(f"{pad}{k_str}: []")
        else:
            lines.append(f"{pad}{k_str}:")
            _emit_sequence(val, indent, lines)
    else:
        s_val = _format_unity_scalar(val)
        if s_val == "":
            lines.append(f"{pad}{k_str}: ")
        else:
            lines.append(f"{pad}{k_str}: {s_val}")


def _emit_sequence(seq: list[Any], indent: int, lines: list[str]) -> None:
    """Emit a YAML sequence using Unity's native indentation (`- ` aligned with parent key)."""
    pad = " " * indent
    for item in seq:
        if isinstance(item, dict):
            if not item:
                lines.append(f"{pad}- {{}}")
            elif is_unity_pptr_dict(item):
                lines.append(f"{pad}- {_format_inline_pptr(item)}")
            else:
                items_iter = list(item.items())
                first_k, first_v = items_iter[0]
                fk_str = _format_unity_scalar(first_k)
                if isinstance(first_v, dict):
                    if not first_v:
                        lines.append(f"{pad}- {fk_str}: {{}}")
                    elif is_unity_pptr_dict(first_v):
                        lines.append(f"{pad}- {fk_str}: {_format_inline_pptr(first_v)}")
                    else:
                        lines.append(f"{pad}- {fk_str}:")
                        for nk, nv in first_v.items():
                            _emit_mapping_entry(nk, nv, indent + 4, lines)
                elif isinstance(first_v, list):
                    if not first_v:
                        lines.append(f"{pad}- {fk_str}: []")
                    else:
                        lines.append(f"{pad}- {fk_str}:")
                        _emit_sequence(first_v, indent + 2, lines)
                else:
                    fv_str = _format_unity_scalar(first_v)
                    if fv_str == "":
                        lines.append(f"{pad}- {fk_str}: ")
                    else:
                        lines.append(f"{pad}- {fk_str}: {fv_str}")

                for rest_k, rest_v in items_iter[1:]:
                    _emit_mapping_entry(rest_k, rest_v, indent + 2, lines)
        elif isinstance(item, list):
            if not item:
                lines.append(f"{pad}- []")
            else:
                lines.append(f"{pad}-")
                _emit_sequence(item, indent + 2, lines)
        else:
            s_item = _format_unity_scalar(item)
            lines.append(f"{pad}- {s_item}")


def dump_unity_meta(meta_dict: dict[str, Any]) -> str:
    """Serialize a Unity `.meta` dictionary into genuine Unity YAML text (LF endings)."""
    lines: list[str] = []
    priority_keys = ("fileFormatVersion", "guid", "ModelImporter")
    emitted: set[Any] = set()

    for pk in priority_keys:
        if pk in meta_dict:
            _emit_mapping_entry(pk, meta_dict[pk], 0, lines)
            emitted.add(pk)

    for k, v in meta_dict.items():
        if k not in emitted:
            _emit_mapping_entry(k, v, 0, lines)

    return "\n".join(lines) + "\n"


def atomic_write_text(target_path: Path | str, content: str) -> bool:
    """Write `content` (UTF-8, LF) atomically only if it differs from disk.

    Returns True if the file was created or modified, False if already identical.
    """
    target = Path(target_path)
    if target.exists():
        try:
            existing = target.read_text(encoding="utf-8")
            if existing == content:
                return False
        except (OSError, UnicodeDecodeError):
            pass

    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        os.replace(tmp_name, target)
    except Exception:
        if os.path.exists(tmp_name):
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
        raise
    return True


def write_json_report(report_path: Path | str, payload: dict[str, Any]) -> None:
    """Atomically write a formatted JSON report file."""
    content = json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=False) + "\n"
    atomic_write_text(report_path, content)


# ---------------------------------------------------------------------------
# Incremental Analysis & GUID Cache
# ---------------------------------------------------------------------------


class AssetCache:
    """Persistent cache stored in `.cache/fbx_meta_cache.json` (gitignored).

    Accelerates batch runs across 100-500+ FBX files by caching SHA-256 -> analysis
    and enables reliable rename GUID recovery & GUID stability checks even outside Git.
    """

    SCHEMA_VERSION = 1

    def __init__(self, cache_path: Path | str) -> None:
        self.cache_path = Path(cache_path)
        self.assets: dict[str, dict[str, Any]] = {}
        self.config_hash: str = ""
        self._load()

    def _load(self) -> None:
        if not self.cache_path.exists():
            return
        try:
            raw = json.loads(self.cache_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and raw.get("schema_version") == self.SCHEMA_VERSION:
                assets = raw.get("assets", {})
                if isinstance(assets, dict):
                    self.assets = assets
                self.config_hash = str(raw.get("config_hash", ""))
        except (OSError, ValueError, TypeError):
            # Resilient recovery on corrupted cache
            self.assets = {}
            self.config_hash = ""

    def save(self) -> None:
        payload = {
            "schema_version": self.SCHEMA_VERSION,
            "config_hash": self.config_hash,
            "assets": dict(sorted(self.assets.items())),
        }
        write_json_report(self.cache_path, payload)

    def get_entry(self, rel_path: str) -> dict[str, Any] | None:
        return self.assets.get(normalize_unicode(rel_path))

    def set_entry(
        self,
        rel_path: str,
        *,
        sha256: str,
        size_bytes: int,
        guid: str | None = None,
        analysis: dict[str, Any] | None = None,
    ) -> None:
        norm = normalize_unicode(rel_path)
        prev = self.assets.get(norm, {})
        self.assets[norm] = {
            "sha256": sha256,
            "size_bytes": size_bytes,
            "guid": guid if guid is not None else prev.get("guid"),
            "analysis": analysis if analysis is not None else prev.get("analysis"),
        }

    def remove_entry(self, rel_path: str) -> None:
        self.assets.pop(normalize_unicode(rel_path), None)

    def find_missing_paths_by_sha256(
        self, sha256: str, repo_root: Path
    ) -> list[tuple[str, dict[str, Any]]]:
        """Find cached entries matching `sha256` whose FBX file no longer exists on disk."""
        matches: list[tuple[str, dict[str, Any]]] = []
        for rel_path, info in self.assets.items():
            if info.get("sha256") == sha256:
                if not (repo_root / rel_path).exists():
                    matches.append((rel_path, info))
        return matches


# ---------------------------------------------------------------------------
# Git Change, Rename, and Historical Metadata Lookup
# ---------------------------------------------------------------------------


class GitChanges:
    """Detected FBX asset changes in a Git repository."""

    def __init__(self) -> None:
        self.is_git_repo: bool = False
        self.base_ref: str | None = None
        self.added_or_modified: set[str] = set()
        self.deleted: set[str] = set()
        # Maps new_rel_path -> old_rel_path
        self.renamed: dict[str, str] = {}


def _run_git(repo_root: Path, args: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        cwd=str(repo_root),
        capture_output=True,
        check=False,
        timeout=30,
    )


def is_git_repository(repo_root: Path | str) -> bool:
    res = _run_git(Path(repo_root), ["rev-parse", "--is-inside-work-tree"])
    return res.returncode == 0 and res.stdout.strip() == b"true"


def git_ref_exists(repo_root: Path | str, ref: str) -> bool:
    if not ref or set(ref) == {"0"}:
        return False
    res = _run_git(Path(repo_root), ["cat-file", "-e", f"{ref}^{{commit}}"])
    return res.returncode == 0


def read_git_file_text(repo_root: Path | str, ref: str, rel_path: str) -> str | None:
    """Read a UTF-8 file from a Git commit ref (`git show <ref>:<rel_path>`)."""
    if not ref:
        return None
    res = _run_git(Path(repo_root), ["show", f"{ref}:{rel_path}"])
    if res.returncode != 0:
        return None
    return res.stdout.decode("utf-8", errors="replace")


def read_git_file_sha256(repo_root: Path | str, ref: str, rel_path: str) -> str | None:
    """Compute SHA-256 of a file stored at `<ref>:<rel_path>` without writing to disk."""
    if not ref:
        return None
    res = _run_git(Path(repo_root), ["show", f"{ref}:{rel_path}"])
    if res.returncode != 0:
        return None
    return hashlib.sha256(res.stdout).hexdigest()


def list_git_meta_guids_at_ref(
    repo_root: Path | str, ref: str, animations_rel_dir: str = "animations"
) -> dict[str, str]:
    """Return `{meta_rel_path: guid}` for `.meta` files tracked in Git at `ref`."""
    root = Path(repo_root)
    if not is_git_repository(root) or not git_ref_exists(root, ref):
        return {}
    res = _run_git(root, ["ls-tree", "-r", "-z", "--name-only", ref, "--", animations_rel_dir])
    if res.returncode != 0:
        return {}
    result: dict[str, str] = {}
    for raw_path in res.stdout.split(b"\x00"):
        if not raw_path:
            continue
        rel_path = normalize_unicode(raw_path.decode("utf-8", errors="replace"))
        if not rel_path.endswith(".meta"):
            continue
        text = read_git_file_text(root, ref, rel_path)
        if not text:
            continue
        m = _FAST_GUID_LINE_RE.search(text[:2048])
        if m:
            guid = m.group(1).strip().strip("'\"")
            if is_valid_unity_guid(guid):
                result[rel_path] = guid
    return result


def detect_git_fbx_changes(
    repo_root: Path | str,
    animations_rel_dir: str = "animations",
    base_ref: str | None = None,
    head_ref: str = "HEAD",
) -> GitChanges:
    """Detect added, modified, deleted, and renamed FBX assets using Git diff + working tree."""
    root = Path(repo_root).resolve()
    info = GitChanges()
    if not is_git_repository(root):
        return info
    info.is_git_repo = True

    effective_base: str | None = None
    if base_ref and git_ref_exists(root, base_ref):
        effective_base = base_ref
    elif git_ref_exists(root, "HEAD~1") and base_ref == "HEAD~1":
        effective_base = "HEAD~1"
    elif git_ref_exists(root, "HEAD"):
        effective_base = "HEAD"

    info.base_ref = effective_base

    # 1. Committed range diff (e.g. push before..HEAD) with rename detection (-M85%)
    if base_ref and effective_base == base_ref and git_ref_exists(root, head_ref):
        res = _run_git(
            root,
            [
                "-c",
                "core.quotePath=false",
                "diff",
                "--name-status",
                "-z",
                "-M85%",
                effective_base,
                head_ref,
                "--",
                animations_rel_dir,
            ],
        )
        if res.returncode == 0 and res.stdout:
            _parse_nul_name_status(res.stdout, info)

    # 2. Working-tree + staged changes relative to HEAD (for local runs & uncommitted changes)
    if git_ref_exists(root, "HEAD"):
        res_wt = _run_git(
            root,
            [
                "-c",
                "core.quotePath=false",
                "diff",
                "--name-status",
                "-z",
                "-M85%",
                "HEAD",
                "--",
                animations_rel_dir,
            ],
        )
        if res_wt.returncode == 0 and res_wt.stdout:
            _parse_nul_name_status(res_wt.stdout, info)

    # 3. Untracked FBX files in working tree
    res_untracked = _run_git(
        root,
        [
            "-c",
            "core.quotePath=false",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            animations_rel_dir,
        ],
    )
    if res_untracked.returncode == 0 and res_untracked.stdout:
        for raw_p in res_untracked.stdout.split(b"\x00"):
            if not raw_p:
                continue
            rel_p = normalize_unicode(raw_p.decode("utf-8", errors="replace"))
            if is_fbx_file(rel_p):
                info.added_or_modified.add(rel_p)

    # Reconcile untracked + deleted working-tree renames by exact SHA-256 against effective_base
    if effective_base and info.deleted and info.added_or_modified:
        unresolved_new = [p for p in info.added_or_modified if p not in info.renamed]
        if unresolved_new:
            deleted_by_sha: dict[str, list[str]] = {}
            for del_p in list(info.deleted):
                if (root / del_p).exists():
                    continue
                sha = read_git_file_sha256(root, effective_base, del_p)
                if sha:
                    deleted_by_sha.setdefault(sha, []).append(del_p)

            for new_p in unresolved_new:
                full_new = root / new_p
                if not full_new.exists():
                    continue
                new_sha = compute_sha256(full_new)
                candidates = deleted_by_sha.get(new_sha, [])
                if len(candidates) == 1:
                    old_p = candidates.pop(0)
                    info.renamed[new_p] = old_p

    return info


def _parse_nul_name_status(raw: bytes, info: GitChanges) -> None:
    tokens = raw.split(b"\x00")
    idx = 0
    n = len(tokens)
    while idx < n:
        status_tok = tokens[idx].decode("utf-8", errors="replace")
        idx += 1
        if not status_tok:
            continue
        code = status_tok[0]
        if code in ("R", "C") and idx + 1 < n:
            old_p = normalize_unicode(tokens[idx].decode("utf-8", errors="replace"))
            new_p = normalize_unicode(tokens[idx + 1].decode("utf-8", errors="replace"))
            idx += 2
            if is_fbx_file(new_p):
                info.added_or_modified.add(new_p)
                if code == "R" and is_fbx_file(old_p):
                    info.renamed[new_p] = old_p
                    info.deleted.add(old_p)
        elif idx < n:
            p = normalize_unicode(tokens[idx].decode("utf-8", errors="replace"))
            idx += 1
            if not is_fbx_file(p):
                continue
            if code == "D":
                info.deleted.add(p)
            else:
                info.added_or_modified.add(p)


def load_json_config(config_path: Path | str) -> dict[str, Any]:
    """Load and validate a JSON configuration file."""
    p = Path(config_path)
    if not p.exists():
        raise FileNotFoundError(f"Configuration file not found: {p}")
    data = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Configuration root must be a JSON object: {p}")
    return data


def compute_config_hash(*config_paths: Path | str) -> str:
    """Compute a combined SHA-256 fingerprint across configuration files."""
    hasher = hashlib.sha256()
    for cp in config_paths:
        p = Path(cp)
        if p.exists():
            hasher.update(p.name.encode("utf-8"))
            hasher.update(b"\x00")
            hasher.update(p.read_bytes())
            hasher.update(b"\x00")
    return hasher.hexdigest()[:16]
