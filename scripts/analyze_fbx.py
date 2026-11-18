#!/usr/bin/env python3
"""Automated FBX Animation Inspector & Rig Classifier.

Parses Autodesk FBX Binary (v6.x - v7.7+, both 32-bit and 64-bit node records)
and FBX ASCII files without requiring proprietary SDKs or paid APIs, with
optional headless Blender enrichment when available.

Extracts:
- File integrity, Git LFS pointer status, format (binary/ascii), FBX version
- Frame rate (GlobalSettings TimeMode & CustomFrameRate)
- Animation stacks/takes, keyframe curve counts, start/end frames, duration
- Mesh geometry presence & vertex counts (streamed without loading vertex buffers)
- Skeleton / bone hierarchy (LimbNode, Root, Skin Cluster deformers, Connections)
- Rig compatibility (Humanoid vs Generic vs Unknown) with anatomical tree check
- Heuristic animation category suggestion with user rule overrides
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.utils import (
    compute_sha256,
    derive_clip_name_from_asset,
    discover_fbx_files,
    load_json_config,
    normalize_rel_path,
    normalize_unicode,
    write_json_report,
)

FBX_BINARY_MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"
FBX_KTIME_ONE_SECOND = 46186158000
MIN_SUPPORTED_FBX_VERSION = 6000
MAX_SUPPORTED_FBX_VERSION = 8999
MAX_ZLIB_DECOMPRESS_BYTES = 64 * 1024 * 1024  # 64 MB safety cap per array

# Autodesk FBX SDK FbxTime::EMode -> FPS mapping
FBX_TIMEMODE_FPS: dict[int, float] = {
    0: 30.0,  # eDefaultMode (30 fps unless CustomFrameRate > 0)
    1: 120.0,
    2: 100.0,
    3: 60.0,
    4: 50.0,
    5: 48.0,
    6: 30.0,
    7: 30.0,
    8: 29.97002617,
    9: 25.0,
    10: 24.0,
    11: 1000.0,
    12: 23.976,
    13: -1.0,  # eCustom -> use CustomFrameRate
    14: 96.0,
    15: 72.0,
    16: 59.94,
    17: 119.88,
}

# 15 mandatory Unity Mecanim Humanoid bones
REQUIRED_HUMANOID_BONES: tuple[str, ...] = (
    "Hips",
    "Spine",
    "Head",
    "LeftUpperLeg",
    "LeftLowerLeg",
    "LeftFoot",
    "RightUpperLeg",
    "RightLowerLeg",
    "RightFoot",
    "LeftUpperArm",
    "LeftLowerArm",
    "LeftHand",
    "RightUpperArm",
    "RightLowerArm",
    "RightHand",
)

OPTIONAL_HUMANOID_BONES: tuple[str, ...] = (
    "Chest",
    "UpperChest",
    "Neck",
    "LeftShoulder",
    "RightShoulder",
    "LeftToes",
    "RightToes",
)

# Comprehensive studio bone alias patterns (Mixamo, Maya HIK, 3ds Max Biped, Unreal, Rigify, CC, VRM)
_HUMANOID_BONE_ALIASES: dict[str, tuple[str, ...]] = {
    "Hips": ("hips", "pelvis", "hip", "cog", "centerofgravity", "c_hips"),
    "Spine": ("spine", "spine1", "spine01", "spine_01", "abdomen", "waist", "back", "c_spine"),
    "Chest": ("chest", "spine2", "spine02", "spine_02", "thorax", "ribcage", "c_chest"),
    "UpperChest": ("upperchest", "spine3", "spine03", "spine_03", "spine_04", "c_upperchest"),
    "Neck": ("neck", "neck1", "neck01", "neck_01", "c_neck"),
    "Head": ("head", "c_head"),
    "LeftShoulder": (
        "leftshoulder",
        "lshoulder",
        "shoulderl",
        "lclavicle",
        "claviclel",
        "leftcollar",
        "lcollar",
    ),
    "RightShoulder": (
        "rightshoulder",
        "rshoulder",
        "shoulderr",
        "rclavicle",
        "clavicler",
        "rightcollar",
        "rcollar",
    ),
    "LeftUpperArm": (
        "leftupperarm",
        "leftarm",
        "lupperarm",
        "upperarml",
        "larm",
        "arml",
        "leftuparm",
    ),
    "RightUpperArm": (
        "rightupperarm",
        "rightarm",
        "rupperarm",
        "upperarmr",
        "rarm",
        "armr",
        "rightuparm",
    ),
    "LeftLowerArm": (
        "leftlowerarm",
        "leftforearm",
        "llowerarm",
        "lowerarml",
        "lforearm",
        "forearml",
        "leftelbow",
    ),
    "RightLowerArm": (
        "rightlowerarm",
        "rightforearm",
        "rlowerarm",
        "lowerarmr",
        "rforearm",
        "forearmr",
        "rightelbow",
    ),
    "LeftHand": ("lefthand", "lhand", "handl", "lwrist", "wristl", "leftwrist"),
    "RightHand": ("righthand", "rhand", "handr", "rwrist", "wristr", "rightwrist"),
    "LeftUpperLeg": (
        "leftupperleg",
        "leftupleg",
        "leftthigh",
        "lupperleg",
        "lupleg",
        "lthigh",
        "thighl",
        "upperlegl",
        "uplegl",
    ),
    "RightUpperLeg": (
        "rightupperleg",
        "rightupleg",
        "rightthigh",
        "rupperleg",
        "rupleg",
        "rthigh",
        "thighr",
        "upperlegr",
        "uplegr",
    ),
    "LeftLowerLeg": (
        "leftlowerleg",
        "leftleg",
        "leftcalf",
        "leftshin",
        "llowerleg",
        "lleg",
        "lcalf",
        "lshin",
        "calfl",
        "shinl",
        "legl",
        "lowerlegl",
        "lknee",
    ),
    "RightLowerLeg": (
        "rightlowerleg",
        "rightleg",
        "rightcalf",
        "rightshin",
        "rlowerleg",
        "rleg",
        "rcalf",
        "rshin",
        "calfr",
        "shinr",
        "legr",
        "lowerlegr",
        "rknee",
    ),
    "LeftFoot": ("leftfoot", "lfoot", "footl", "lankle", "anklel", "leftankle"),
    "RightFoot": ("rightfoot", "rfoot", "footr", "rankle", "ankler", "rightankle"),
    "LeftToes": ("lefttoebase", "lefttoes", "lefttoe", "ltoebase", "ltoes", "ltoe", "toel", "balll"),
    "RightToes": (
        "righttoebase",
        "righttoes",
        "righttoe",
        "rtoebase",
        "rtoes",
        "rtoe",
        "toer",
        "ballr",
    ),
}

_COMMON_BONE_PREFIX_RE = re.compile(
    r"^(?:.*:|mixamorig\d*[_:]?|bip0*\d+[\s_-]+|valvebiped\.bip01_|cc_base_|j_bip_|def[-_]|org[-_]|mch[-_]|character\d*_)",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Internal Parsed Scene Representation
# ---------------------------------------------------------------------------


@dataclass
class ParsedModel:
    obj_id: int
    name: str
    subtype: str  # e.g. "LimbNode", "Root", "Null", "Mesh"


@dataclass
class ParsedAnimStack:
    obj_id: int
    name: str
    local_start_ktime: int | None = None
    local_stop_ktime: int | None = None
    ref_start_ktime: int | None = None
    ref_stop_ktime: int | None = None


@dataclass
class ParsedAnimCurve:
    obj_id: int
    key_count: int = 0
    min_ktime: int | None = None
    max_ktime: int | None = None


@dataclass
class ParsedTakeFallback:
    name: str
    start_ktime: int | None = None
    stop_ktime: int | None = None
    has_inline_keys: bool = False


@dataclass
class RawFBXScene:
    fbx_format: str  # "binary" | "ascii"
    fbx_version: int
    creator: str = ""
    application: str = ""
    time_mode: int | None = None
    custom_frame_rate: float | None = None
    models: dict[int, ParsedModel] = field(default_factory=dict)
    node_attr_subtypes: dict[int, str] = field(default_factory=dict)
    meshes: dict[int, int] = field(default_factory=dict)  # geom_id -> vertex_count
    mesh_names: list[str] = field(default_factory=list)
    cluster_ids: set[int] = field(default_factory=set)
    anim_stacks: dict[int, ParsedAnimStack] = field(default_factory=dict)
    anim_layers: set[int] = field(default_factory=set)
    anim_curve_nodes: set[int] = field(default_factory=set)
    anim_curves: dict[int, ParsedAnimCurve] = field(default_factory=dict)
    connections: list[tuple[int, int]] = field(default_factory=list)  # (child_id, parent_id)
    takes_section: list[ParsedTakeFallback] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class FBXFormatError(ValueError):
    """Raised when an FBX file is corrupted, truncated, or structurally invalid."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Binary FBX Streaming Parser
# ---------------------------------------------------------------------------


def _split_fbx_object_name(raw_name: str) -> str:
    """Extract clean object name from `'Name\\x00\\x01Class'` or `'Class::Name'`."""
    if "\x00\x01" in raw_name:
        return raw_name.split("\x00\x01", 1)[0].strip()
    if "::" in raw_name:
        return raw_name.split("::", 1)[1].strip()
    return raw_name.strip()


def _read_exact(fh: BinaryIO, count: int) -> bytes:
    buf = fh.read(count)
    if len(buf) != count:
        raise FBXFormatError(
            "CORRUPTED_FBX",
            f"Unexpected end of binary FBX stream (expected {count} bytes at offset {fh.tell() - len(buf)}, got {len(buf)})",
        )
    return buf


def _read_node_header(
    fh: BinaryIO, is_64bit: bool, file_size: int
) -> tuple[int, int, int, str] | None:
    header_size = 25 if is_64bit else 13
    pos = fh.tell()
    if pos + header_size > file_size:
        return None
    raw = _read_exact(fh, header_size)
    if is_64bit:
        end_offset, num_props, prop_list_len, name_len = struct.unpack("<QQQB", raw)
    else:
        end_offset, num_props, prop_list_len, name_len = struct.unpack("<IIIB", raw)

    if end_offset == 0 and num_props == 0 and prop_list_len == 0 and name_len == 0:
        return None  # Null sentinel record

    if end_offset > file_size or end_offset <= pos:
        raise FBXFormatError(
            "CORRUPTED_FBX",
            f"Invalid FBX node end_offset {end_offset} at position {pos} (file size {file_size})",
        )

    name_bytes = _read_exact(fh, name_len) if name_len > 0 else b""
    name = name_bytes.decode("utf-8", errors="replace")
    return end_offset, num_props, prop_list_len, name


def _read_properties(
    fh: BinaryIO,
    num_props: int,
    *,
    decode_arrays: bool = False,
    capture_array_lengths_only: bool = False,
) -> list[Any]:
    """Read `num_props` FBX node properties from `fh`."""
    props: list[Any] = []
    for _ in range(num_props):
        t_code = _read_exact(fh, 1)
        if t_code == b"Y":
            props.append(struct.unpack("<h", _read_exact(fh, 2))[0])
        elif t_code == b"C":
            props.append(struct.unpack("<B", _read_exact(fh, 1))[0])
        elif t_code == b"I":
            props.append(struct.unpack("<i", _read_exact(fh, 4))[0])
        elif t_code == b"F":
            props.append(struct.unpack("<f", _read_exact(fh, 4))[0])
        elif t_code == b"D":
            props.append(struct.unpack("<d", _read_exact(fh, 8))[0])
        elif t_code == b"L":
            props.append(struct.unpack("<q", _read_exact(fh, 8))[0])
        elif t_code == b"S":
            slen = struct.unpack("<I", _read_exact(fh, 4))[0]
            sbytes = _read_exact(fh, slen)
            props.append(sbytes.decode("utf-8", errors="replace"))
        elif t_code == b"R":
            rlen = struct.unpack("<I", _read_exact(fh, 4))[0]
            fh.seek(rlen, os.SEEK_CUR)
            props.append(None)
        elif t_code in (b"f", b"d", b"l", b"i", b"b"):
            arr_len, encoding, comp_len = struct.unpack("<III", _read_exact(fh, 12))
            if capture_array_lengths_only and not decode_arrays:
                fh.seek(comp_len, os.SEEK_CUR)
                props.append(("__array_len__", arr_len))
                continue
            if not decode_arrays:
                fh.seek(comp_len, os.SEEK_CUR)
                props.append(None)
                continue

            elem_sizes = {b"f": 4, b"d": 8, b"l": 8, b"i": 4, b"b": 1}
            expected_bytes = arr_len * elem_sizes[t_code]
            if expected_bytes > MAX_ZLIB_DECOMPRESS_BYTES:
                fh.seek(comp_len, os.SEEK_CUR)
                props.append(("__array_len__", arr_len))
                continue

            payload = _read_exact(fh, comp_len)
            if encoding == 1:
                try:
                    raw_arr = zlib.decompress(payload, bufsize=max(expected_bytes, 64))
                except zlib.error as exc:
                    raise FBXFormatError(
                        "CORRUPTED_FBX", f"Corrupted zlib-compressed FBX property array: {exc}"
                    ) from exc
            elif encoding == 0:
                raw_arr = payload
            else:
                raise FBXFormatError(
                    "CORRUPTED_FBX", f"Unsupported FBX array encoding {encoding}"
                )

            if len(raw_arr) != expected_bytes:
                raise FBXFormatError(
                    "CORRUPTED_FBX",
                    f"Decompressed FBX array byte length mismatch ({len(raw_arr)} != {expected_bytes})",
                )
            fmt_char = {b"f": "f", b"d": "d", b"l": "q", b"i": "i", b"b": "B"}[t_code]
            if arr_len == 0:
                props.append(())
            else:
                props.append(struct.unpack(f"<{arr_len}{fmt_char}", raw_arr))
        else:
            raise FBXFormatError(
                "CORRUPTED_FBX",
                f"Unknown binary FBX property type code {t_code!r} at offset {fh.tell() - 1}",
            )
    return props


def _iter_children(fh: BinaryIO, parent_end: int, is_64bit: bool, file_size: int):
    sentinel_len = 25 if is_64bit else 13
    while fh.tell() + sentinel_len <= parent_end:
        hdr = _read_node_header(fh, is_64bit, file_size)
        if hdr is None:
            break
        end_off, num_props, prop_len, name = hdr
        if end_off > parent_end:
            raise FBXFormatError(
                "CORRUPTED_FBX",
                f"Child node '{name}' end_offset ({end_off}) exceeds parent end ({parent_end})",
            )
        children_start = fh.tell() + prop_len
        yield name, num_props, prop_len, children_start, end_off
        fh.seek(end_off)


def _parse_properties70(
    fh: BinaryIO, children_start: int, end_off: int, is_64bit: bool, file_size: int
) -> dict[str, Any]:
    fh.seek(children_start)
    result: dict[str, Any] = {}
    for cname, nprops, plen, _, c_end in _iter_children(fh, end_off, is_64bit, file_size):
        if cname in ("P", "Property") and nprops >= 4:
            props = _read_properties(fh, nprops)
            prop_name = str(props[0])
            # Value sits at index 4 in Properties70 ('P': name, type, label, flags, val...)
            # or index 3 in Properties60 ('Property': name, type, flags, val...)
            val_idx = 4 if cname == "P" and len(props) >= 5 else 3
            if len(props) > val_idx:
                result[prop_name] = props[val_idx]
        fh.seek(c_end)
    return result


def parse_binary_fbx(fh: BinaryIO, file_size: int) -> RawFBXScene:
    """Stream-parse a Kaydara Binary FBX file into `RawFBXScene`."""
    if file_size < 27:
        raise FBXFormatError("CORRUPTED_FBX", "Binary FBX file is shorter than 27-byte header")

    magic = _read_exact(fh, 23)
    if magic != FBX_BINARY_MAGIC:
        raise FBXFormatError("INVALID_FBX_HEADER", "Invalid Kaydara FBX Binary magic header")

    version = struct.unpack("<I", _read_exact(fh, 4))[0]
    if version < MIN_SUPPORTED_FBX_VERSION or version > MAX_SUPPORTED_FBX_VERSION:
        raise FBXFormatError(
            "UNSUPPORTED_FBX_VERSION",
            f"Unsupported binary FBX version {version} (supported range: {MIN_SUPPORTED_FBX_VERSION}-{MAX_SUPPORTED_FBX_VERSION})",
        )

    is_64bit = version >= 7500
    scene = RawFBXScene(fbx_format="binary", fbx_version=version)

    sentinel_len = 25 if is_64bit else 13
    saw_any_section = False

    while fh.tell() + sentinel_len <= file_size:
        hdr = _read_node_header(fh, is_64bit, file_size)
        if hdr is None:
            break
        saw_any_section = True
        end_off, num_props, prop_len, section_name = hdr
        children_start = fh.tell() + prop_len

        if section_name == "FBXHeaderExtension":
            fh.seek(children_start)
            for cname, nprops, plen, gc_start, c_end in _iter_children(
                fh, end_off, is_64bit, file_size
            ):
                if cname == "Creator" and nprops >= 1:
                    p = _read_properties(fh, 1)
                    scene.creator = str(p[0])
                elif cname == "SceneInfo":
                    fh.seek(gc_start)
                    for sc_name, _, sc_plen, sc_cstart, sc_end in _iter_children(
                        fh, c_end, is_64bit, file_size
                    ):
                        if sc_name in ("Properties70", "Properties60"):
                            p70 = _parse_properties70(fh, sc_cstart, sc_end, is_64bit, file_size)
                            app = p70.get("Original|ApplicationName") or p70.get(
                                "LastSaved|ApplicationName"
                            )
                            if app:
                                scene.application = str(app)
                        fh.seek(sc_end)

        elif section_name == "GlobalSettings":
            fh.seek(children_start)
            for cname, _, _, gc_start, c_end in _iter_children(fh, end_off, is_64bit, file_size):
                if cname in ("Properties70", "Properties60"):
                    p70 = _parse_properties70(fh, gc_start, c_end, is_64bit, file_size)
                    if "TimeMode" in p70 and isinstance(p70["TimeMode"], int):
                        scene.time_mode = p70["TimeMode"]
                    if "CustomFrameRate" in p70 and isinstance(
                        p70["CustomFrameRate"], (int, float)
                    ):
                        scene.custom_frame_rate = float(p70["CustomFrameRate"])

        elif section_name == "Objects":
            fh.seek(children_start)
            for obj_type, nprops, plen, obj_cstart, obj_end in _iter_children(
                fh, end_off, is_64bit, file_size
            ):
                props = _read_properties(fh, nprops) if nprops > 0 else []
                # In FBX 7.x: props = [id (int64), "Name\x00\x01Class", "Subtype"]
                # In FBX 6.x: props = ["Model::Name", "Subtype"]
                obj_id: int
                raw_name: str
                subtype: str
                if props and isinstance(props[0], int):
                    obj_id = props[0]
                    raw_name = str(props[1]) if len(props) > 1 else ""
                    subtype = str(props[2]) if len(props) > 2 else ""
                else:
                    obj_id = hash((obj_type, props[0] if props else obj_end)) & 0x7FFFFFFFFFFFFFFF
                    raw_name = str(props[0]) if len(props) > 0 else ""
                    subtype = str(props[1]) if len(props) > 1 else ""

                clean_name = _split_fbx_object_name(raw_name)

                if obj_type == "Model":
                    scene.models[obj_id] = ParsedModel(
                        obj_id=obj_id, name=clean_name, subtype=subtype
                    )
                elif obj_type == "NodeAttribute":
                    scene.node_attr_subtypes[obj_id] = subtype
                elif obj_type == "Geometry":
                    if subtype in ("Mesh", ""):
                        vcount = 0
                        fh.seek(obj_cstart)
                        for g_child, g_nprops, _, _, g_end in _iter_children(
                            fh, obj_end, is_64bit, file_size
                        ):
                            if g_child == "Vertices" and g_nprops >= 1:
                                gp = _read_properties(
                                    fh, g_nprops, capture_array_lengths_only=True
                                )
                                if (
                                    gp
                                    and isinstance(gp[0], tuple)
                                    and gp[0][0] == "__array_len__"
                                ):
                                    vcount = gp[0][1] // 3
                                break
                            fh.seek(g_end)
                        if subtype == "Mesh" or vcount > 0:
                            scene.meshes[obj_id] = vcount
                            scene.mesh_names.append(clean_name or f"Mesh_{obj_id}")
                elif obj_type == "Deformer":
                    if subtype == "Cluster":
                        scene.cluster_ids.add(obj_id)
                elif obj_type == "AnimationStack":
                    stack = ParsedAnimStack(obj_id=obj_id, name=clean_name or "Take 001")
                    fh.seek(obj_cstart)
                    for sc_name, _, _, sc_cstart, sc_end in _iter_children(
                        fh, obj_end, is_64bit, file_size
                    ):
                        if sc_name in ("Properties70", "Properties60"):
                            p70 = _parse_properties70(fh, sc_cstart, sc_end, is_64bit, file_size)
                            if isinstance(p70.get("LocalStart"), int):
                                stack.local_start_ktime = p70["LocalStart"]
                            if isinstance(p70.get("LocalStop"), int):
                                stack.local_stop_ktime = p70["LocalStop"]
                            if isinstance(p70.get("ReferenceStart"), int):
                                stack.ref_start_ktime = p70["ReferenceStart"]
                            if isinstance(p70.get("ReferenceStop"), int):
                                stack.ref_stop_ktime = p70["ReferenceStop"]
                    scene.anim_stacks[obj_id] = stack
                elif obj_type == "AnimationLayer":
                    scene.anim_layers.add(obj_id)
                elif obj_type == "AnimationCurveNode":
                    scene.anim_curve_nodes.add(obj_id)
                elif obj_type == "AnimationCurve":
                    curve = ParsedAnimCurve(obj_id=obj_id)
                    fh.seek(obj_cstart)
                    for c_child, c_nprops, _, _, c_end in _iter_children(
                        fh, obj_end, is_64bit, file_size
                    ):
                        if c_child == "KeyTime" and c_nprops >= 1:
                            cp = _read_properties(fh, 1, decode_arrays=True)
                            if cp and isinstance(cp[0], tuple):
                                if cp[0] and cp[0][0] == "__array_len__":
                                    curve.key_count = int(cp[0][1])
                                else:
                                    ktimes = cp[0]
                                    curve.key_count = len(ktimes)
                                    if ktimes:
                                        curve.min_ktime = min(ktimes)
                                        curve.max_ktime = max(ktimes)
                            break
                        fh.seek(c_end)
                    scene.anim_curves[obj_id] = curve

        elif section_name == "Connections":
            fh.seek(children_start)
            for cname, nprops, _, _, c_end in _iter_children(fh, end_off, is_64bit, file_size):
                if cname in ("C", "Connect") and nprops >= 3:
                    cprops = _read_properties(fh, nprops)
                    if isinstance(cprops[1], int) and isinstance(cprops[2], int):
                        scene.connections.append((cprops[1], cprops[2]))

        elif section_name == "Takes":
            fh.seek(children_start)
            for cname, nprops, _, t_cstart, c_end in _iter_children(
                fh, end_off, is_64bit, file_size
            ):
                if cname == "Take" and nprops >= 1:
                    tprops = _read_properties(fh, nprops)
                    tname = _split_fbx_object_name(str(tprops[0]))
                    tf = ParsedTakeFallback(name=tname or "Take 001")
                    fh.seek(t_cstart)
                    for tc_name, tc_nprops, _, _, tc_end in _iter_children(
                        fh, c_end, is_64bit, file_size
                    ):
                        if tc_name == "LocalTime" and tc_nprops >= 2:
                            lt = _read_properties(fh, 2)
                            if isinstance(lt[0], int) and isinstance(lt[1], int):
                                tf.start_ktime, tf.stop_ktime = lt[0], lt[1]
                        elif tc_name == "ReferenceTime" and tc_nprops >= 2 and tf.start_ktime is None:
                            rt = _read_properties(fh, 2)
                            if isinstance(rt[0], int) and isinstance(rt[1], int):
                                tf.start_ktime, tf.stop_ktime = rt[0], rt[1]
                        elif tc_name == "Model":
                            tf.has_inline_keys = True
                        fh.seek(tc_end)
                    scene.takes_section.append(tf)

        fh.seek(end_off)

    if not saw_any_section:
        raise FBXFormatError("CORRUPTED_FBX", "Binary FBX contains no valid node records")

    return scene


# ---------------------------------------------------------------------------
# ASCII FBX Parser
# ---------------------------------------------------------------------------

_ASCII_VERSION_RE = re.compile(r"\bFBXVersion:\s*(\d+)")
_ASCII_COMMENT_VER_RE = re.compile(r"^;\s*FBX\s+(\d+)\.(\d+)\.(\d+)\s+project\s+file", re.MULTILINE)
_ASCII_PROP70_INT_RE = re.compile(
    r'P:\s*"([^"]+)"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*(-?\d+(?:\.\d+)?)'
)


def _check_ascii_brace_balance(text: str) -> None:
    depth = 0
    in_quotes = False
    escape = False
    for line in text.splitlines():
        for ch in line:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_quotes = not in_quotes
                continue
            if in_quotes:
                continue
            if ch == ";":
                break
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth < 0:
                    raise FBXFormatError(
                        "CORRUPTED_FBX", "Unmatched closing brace '}' in ASCII FBX"
                    )
    if in_quotes:
        raise FBXFormatError("CORRUPTED_FBX", "Unterminated string literal in ASCII FBX")
    if depth != 0:
        raise FBXFormatError(
            "CORRUPTED_FBX",
            f"Truncated or unbalanced braces in ASCII FBX (unclosed depth={depth})",
        )


def _iter_ascii_blocks(text: str):
    """Yield `(header_line, inner_body)` for top-level `{ ... }` blocks in `text`."""
    n = len(text)
    i = 0
    while i < n:
        # Skip whitespace and `;` comments
        while i < n and text[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        if text[i] == ";":
            nl = text.find("\n", i)
            if nl == -1:
                break
            i = nl + 1
            continue

        # Scan statement until newline or '{' (respecting quotes)
        stmt_start = i
        in_q = False
        brace_pos = -1
        while i < n:
            c = text[i]
            if c == '"' and (i == 0 or text[i - 1] != "\\"):
                in_q = not in_q
            elif not in_q:
                if c == ";":
                    nl = text.find("\n", i)
                    i = n if nl == -1 else nl
                    break
                if c == "{":
                    brace_pos = i
                    break
                if c == "\n":
                    break
            i += 1

        if brace_pos == -1:
            i += 1
            continue

        header = text[stmt_start:brace_pos].strip()
        depth = 1
        j = brace_pos + 1
        in_q = False
        while j < n and depth > 0:
            c = text[j]
            if c == '"' and (j == 0 or text[j - 1] != "\\"):
                in_q = not in_q
            elif not in_q:
                if c == ";":
                    nl = text.find("\n", j)
                    if nl == -1:
                        j = n
                        break
                    j = nl
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
            j += 1

        body = text[brace_pos + 1 : j - 1]
        yield header, body
        i = j


_ASCII_OBJ_HDR_RE = re.compile(
    r'^(\w+):\s*(?:(-?\d+)\s*,\s*)?"([^"]*)"(?:\s*,\s*"([^"]*)")?\s*$'
)
_ASCII_CONN_RE = re.compile(r'C:\s*"[^"]+"\s*,\s*(-?\d+)\s*,\s*(-?\d+)')
_ASCII_KEYTIME_RE = re.compile(r"KeyTime:\s*\*(\d+)\s*\{\s*a:\s*([0-9,\s-]+)\}", re.DOTALL)
_ASCII_VERTS_RE = re.compile(r"Vertices:\s*\*(\d+)\s*\{")
_ASCII_LOCALTIME_RE = re.compile(r"LocalTime:\s*(-?\d+)\s*,\s*(-?\d+)")
_ASCII_REFTIME_RE = re.compile(r"ReferenceTime:\s*(-?\d+)\s*,\s*(-?\d+)")


def parse_ascii_fbx(text: str) -> RawFBXScene:
    """Parse an Autodesk ASCII FBX file into `RawFBXScene`."""
    _check_ascii_brace_balance(text)

    ver_match = _ASCII_VERSION_RE.search(text)
    if ver_match:
        version = int(ver_match.group(1))
    else:
        c_match = _ASCII_COMMENT_VER_RE.search(text)
        if not c_match:
            raise FBXFormatError("INVALID_FBX_HEADER", "Missing FBXVersion in ASCII FBX file")
        version = int(c_match.group(1)) * 1000 + int(c_match.group(2)) * 100

    if version < MIN_SUPPORTED_FBX_VERSION or version > MAX_SUPPORTED_FBX_VERSION:
        raise FBXFormatError(
            "UNSUPPORTED_FBX_VERSION",
            f"Unsupported ASCII FBX version {version} (supported range: {MIN_SUPPORTED_FBX_VERSION}-{MAX_SUPPORTED_FBX_VERSION})",
        )

    scene = RawFBXScene(fbx_format="ascii", fbx_version=version)

    for hdr, body in _iter_ascii_blocks(text):
        sec_name = hdr.split(":", 1)[0].strip()

        if sec_name == "FBXHeaderExtension":
            cm = re.search(r'Creator:\s*"([^"]*)"', body)
            if cm:
                scene.creator = cm.group(1)

        elif sec_name == "GlobalSettings":
            for pname, pval in _ASCII_PROP70_INT_RE.findall(body):
                if pname == "TimeMode":
                    scene.time_mode = int(float(pval))
                elif pname == "CustomFrameRate":
                    scene.custom_frame_rate = float(pval)

        elif sec_name == "Objects":
            for obj_hdr, obj_body in _iter_ascii_blocks(body):
                m = _ASCII_OBJ_HDR_RE.match(obj_hdr)
                if not m:
                    continue
                obj_type = m.group(1)
                raw_id = m.group(2)
                raw_name = m.group(3)
                subtype = m.group(4) or ""
                obj_id = (
                    int(raw_id)
                    if raw_id is not None
                    else (hash((obj_type, raw_name)) & 0x7FFFFFFFFFFFFFFF)
                )
                clean_name = _split_fbx_object_name(raw_name)

                if obj_type == "Model":
                    scene.models[obj_id] = ParsedModel(
                        obj_id=obj_id, name=clean_name, subtype=subtype
                    )
                elif obj_type == "NodeAttribute":
                    scene.node_attr_subtypes[obj_id] = subtype
                elif obj_type == "Geometry":
                    vm = _ASCII_VERTS_RE.search(obj_body)
                    vcount = int(vm.group(1)) // 3 if vm else 0
                    if subtype == "Mesh" or vcount > 0:
                        scene.meshes[obj_id] = vcount
                        scene.mesh_names.append(clean_name or f"Mesh_{obj_id}")
                elif obj_type == "Deformer":
                    if subtype == "Cluster":
                        scene.cluster_ids.add(obj_id)
                elif obj_type == "AnimationStack":
                    stack = ParsedAnimStack(obj_id=obj_id, name=clean_name or "Take 001")
                    for pname, pval in _ASCII_PROP70_INT_RE.findall(obj_body):
                        if pname == "LocalStart":
                            stack.local_start_ktime = int(float(pval))
                        elif pname == "LocalStop":
                            stack.local_stop_ktime = int(float(pval))
                        elif pname == "ReferenceStart":
                            stack.ref_start_ktime = int(float(pval))
                        elif pname == "ReferenceStop":
                            stack.ref_stop_ktime = int(float(pval))
                    scene.anim_stacks[obj_id] = stack
                elif obj_type == "AnimationLayer":
                    scene.anim_layers.add(obj_id)
                elif obj_type == "AnimationCurveNode":
                    scene.anim_curve_nodes.add(obj_id)
                elif obj_type == "AnimationCurve":
                    curve = ParsedAnimCurve(obj_id=obj_id)
                    km = _ASCII_KEYTIME_RE.search(obj_body)
                    if km:
                        ktimes = [
                            int(tok)
                            for tok in km.group(2).replace("\n", ",").split(",")
                            if tok.strip()
                        ]
                        curve.key_count = len(ktimes)
                        if ktimes:
                            curve.min_ktime = min(ktimes)
                            curve.max_ktime = max(ktimes)
                    scene.anim_curves[obj_id] = curve

        elif sec_name == "Connections":
            for child_s, parent_s in _ASCII_CONN_RE.findall(body):
                scene.connections.append((int(child_s), int(parent_s)))

        elif sec_name == "Takes":
            for t_hdr, t_body in _iter_ascii_blocks(body):
                tm = re.match(r'^Take:\s*"([^"]*)"', t_hdr)
                if not tm:
                    continue
                tf = ParsedTakeFallback(name=_split_fbx_object_name(tm.group(1)) or "Take 001")
                lm = _ASCII_LOCALTIME_RE.search(t_body)
                rm = _ASCII_REFTIME_RE.search(t_body)
                if lm:
                    tf.start_ktime, tf.stop_ktime = int(lm.group(1)), int(lm.group(2))
                elif rm:
                    tf.start_ktime, tf.stop_ktime = int(rm.group(1)), int(rm.group(2))
                if "Channel:" in t_body or "Key:" in t_body:
                    tf.has_inline_keys = True
                scene.takes_section.append(tf)

    return scene


# ---------------------------------------------------------------------------
# Rig Compatibility & Hierarchy Analysis
# ---------------------------------------------------------------------------


def _canonical_bone_token(raw_bone_name: str) -> str:
    """Normalize a bone name from DCC/Mixamo/Unreal/Biped conventions for matching."""
    s = _COMMON_BONE_PREFIX_RE.sub("", raw_bone_name.strip())
    lower = s.lower()

    # Handle directional suffixes/prefixes cleanly (.L / _L / -L / L_ / Left)
    side = ""
    if re.search(r"(?:^|[\s._-])(?:left|l)(?:$|[\s._-]|[0-9]+$)", lower):
        side = "left"
        lower = re.sub(r"(?:^|[\s._-])(?:left|l)(?=$|[\s._-]|[0-9]+$)", "", lower)
    elif re.search(r"(?:^|[\s._-])(?:right|r)(?:$|[\s._-]|[0-9]+$)", lower):
        side = "right"
        lower = re.sub(r"(?:^|[\s._-])(?:right|r)(?=$|[\s._-]|[0-9]+$)", "", lower)

    cleaned = re.sub(r"[^a-z0-9]", "", lower)
    if side and not cleaned.startswith(side):
        return f"{side}{cleaned}"
    return cleaned


def _descends_from(
    node_id: int, ancestor_id: int, parent_map: dict[int, int], max_depth: int = 64
) -> bool:
    cur = parent_map.get(node_id)
    steps = 0
    while cur is not None and steps < max_depth:
        if cur == ancestor_id:
            return True
        cur = parent_map.get(cur)
        steps += 1
    return False


def classify_rig(
    bone_models: dict[int, ParsedModel],
    all_models: dict[int, ParsedModel],
    parent_map: dict[int, int],
    animated_model_ids: set[int],
) -> dict[str, Any]:
    """Classify FBX skeleton into Humanoid, Generic, or Unknown without blind assumptions."""
    candidate_models = bone_models if bone_models else {}

    matched_ids: dict[str, int] = {}
    matched_names: dict[str, str] = {}

    # Build lookup over skeleton bones (or all non-mesh models if skeleton uses Nulls)
    pool = candidate_models if len(candidate_models) >= 15 else {
        mid: m for mid, m in all_models.items() if m.subtype != "Mesh"
    }

    for mid, model in sorted(pool.items(), key=lambda kv: len(kv[1].name)):
        canon = _canonical_bone_token(model.name)
        for human_slot, aliases in _HUMANOID_BONE_ALIASES.items():
            if human_slot in matched_ids:
                continue
            if canon in aliases:
                matched_ids[human_slot] = mid
                matched_names[human_slot] = model.name
                break

    missing_required = [b for b in REQUIRED_HUMANOID_BONES if b not in matched_ids]

    hierarchy_valid = True
    hierarchy_issues: list[str] = []
    if not missing_required and parent_map:
        hips_id = matched_ids["Hips"]
        spine_id = matched_ids["Spine"]
        checks = [
            ("Spine", spine_id, "Hips", hips_id),
            ("Head", matched_ids["Head"], "Spine", spine_id),
            ("LeftUpperLeg", matched_ids["LeftUpperLeg"], "Hips", hips_id),
            ("LeftLowerLeg", matched_ids["LeftLowerLeg"], "LeftUpperLeg", matched_ids["LeftUpperLeg"]),
            ("LeftFoot", matched_ids["LeftFoot"], "LeftLowerLeg", matched_ids["LeftLowerLeg"]),
            ("RightUpperLeg", matched_ids["RightUpperLeg"], "Hips", hips_id),
            ("RightLowerLeg", matched_ids["RightLowerLeg"], "RightUpperLeg", matched_ids["RightUpperLeg"]),
            ("RightFoot", matched_ids["RightFoot"], "RightLowerLeg", matched_ids["RightLowerLeg"]),
            ("LeftUpperArm", matched_ids["LeftUpperArm"], "Spine", spine_id),
            ("LeftLowerArm", matched_ids["LeftLowerArm"], "LeftUpperArm", matched_ids["LeftUpperArm"]),
            ("LeftHand", matched_ids["LeftHand"], "LeftLowerArm", matched_ids["LeftLowerArm"]),
            ("RightUpperArm", matched_ids["RightUpperArm"], "Spine", spine_id),
            ("RightLowerArm", matched_ids["RightLowerArm"], "RightUpperArm", matched_ids["RightUpperArm"]),
            ("RightHand", matched_ids["RightHand"], "RightLowerArm", matched_ids["RightLowerArm"]),
        ]
        for child_label, cid, anc_label, aid in checks:
            if cid in parent_map and not _descends_from(cid, aid, parent_map):
                hierarchy_valid = False
                hierarchy_issues.append(f"{child_label} does not descend from {anc_label}")

    has_extra_root = False
    if "Hips" in matched_ids:
        hips_parent = parent_map.get(matched_ids["Hips"])
        if hips_parent is not None and hips_parent != 0 and hips_parent in all_models:
            has_extra_root = True

    if not missing_required and hierarchy_valid:
        optional_hits = sum(1 for ob in OPTIONAL_HUMANOID_BONES if ob in matched_ids)
        confidence = round(min(1.0, 0.90 + 0.015 * optional_hits), 3)
        return {
            "rig_type": "Humanoid",
            "confidence": confidence,
            "matched_humanoid_bones": matched_names,
            "missing_required_humanoid_bones": [],
            "has_extra_root": has_extra_root,
            "hierarchy_valid": True,
            "reason": (
                f"All 15 required Unity Mecanim Humanoid bones verified with valid anatomical "
                f"hierarchy (+{optional_hits} optional Mecanim bones)."
            ),
        }

    if bone_models or animated_model_ids:
        if not missing_required and not hierarchy_valid:
            reason = (
                "Humanoid bone names found, but anatomical hierarchy failed validation ("
                + "; ".join(hierarchy_issues[:3])
                + "); classified safely as Generic."
            )
        elif matched_names:
            reason = (
                f"Skeleton contains {len(bone_models)} bone(s) and {len(animated_model_ids)} "
                f"animated node(s), missing {len(missing_required)} required Humanoid bone(s) "
                f"({', '.join(missing_required[:5])}); classified as Generic."
            )
        else:
            reason = (
                f"Non-humanoid skeleton/transform hierarchy detected "
                f"({len(bone_models)} bone(s), {len(animated_model_ids)} animated transform(s)); "
                f"classified as Generic."
            )
        return {
            "rig_type": "Generic",
            "confidence": 0.9 if bone_models else 0.75,
            "matched_humanoid_bones": matched_names,
            "missing_required_humanoid_bones": missing_required,
            "has_extra_root": False,
            "hierarchy_valid": hierarchy_valid,
            "reason": reason,
        }

    return {
        "rig_type": "Unknown",
        "confidence": 0.0,
        "matched_humanoid_bones": {},
        "missing_required_humanoid_bones": list(REQUIRED_HUMANOID_BONES),
        "has_extra_root": False,
        "hierarchy_valid": False,
        "reason": "No identifiable skeleton bones or animated Model transforms found in FBX.",
    }


# ---------------------------------------------------------------------------
# Animation Category Rule Engine
# ---------------------------------------------------------------------------


def classify_animation_category(
    rel_path: str,
    fbx_path: Path,
    take_names: list[str],
    animation_rules: dict[str, Any] | None,
) -> dict[str, Any]:
    """Classify animation category using explicit overrides first, then priority patterns."""
    if not animation_rules:
        return {
            "category": "Other",
            "source": "default_other",
            "matched_pattern": None,
            "is_heuristic": True,
        }

    default_cat = str(animation_rules.get("default_category", "Other"))
    overrides = animation_rules.get("asset_overrides", {})
    if isinstance(overrides, dict):
        # 1. Exact relative path or filename match, then glob match
        for pat, ov in overrides.items():
            if not isinstance(ov, dict) or "category" not in ov:
                continue
            norm_pat = normalize_unicode(str(pat))
            if (
                norm_pat == rel_path
                or norm_pat == fbx_path.name
                or fnmatch.fnmatch(rel_path, norm_pat)
                or fnmatch.fnmatch(fbx_path.name, norm_pat)
            ):
                return {
                    "category": str(ov["category"]),
                    "source": "explicit_override",
                    "matched_pattern": norm_pat,
                    "is_heuristic": False,
                }

    categories_cfg = animation_rules.get("categories", {})
    if not isinstance(categories_cfg, dict):
        return {
            "category": default_cat,
            "source": "default_other",
            "matched_pattern": None,
            "is_heuristic": True,
        }

    ordered_cats = sorted(
        categories_cfg.items(),
        key=lambda kv: int(kv[1].get("priority", 0)) if isinstance(kv[1], dict) else 0,
        reverse=True,
    )

    stem_candidate = derive_clip_name_from_asset(fbx_path, strip_at_prefix=True)
    full_stem = normalize_unicode(fbx_path.stem)
    generic_takes = {"take 001", "take 01", "default take", "mixamo.com", "scene"}

    # Check filename stem first
    for search_target, source_label in (
        (stem_candidate, "filename_pattern"),
        (full_stem, "filename_pattern"),
    ):
        for cat_name, cat_def in ordered_cats:
            if not isinstance(cat_def, dict):
                continue
            for raw_regex in cat_def.get("patterns", []):
                if re.search(raw_regex, search_target, flags=re.IGNORECASE):
                    return {
                        "category": cat_name,
                        "source": source_label,
                        "matched_pattern": raw_regex,
                        "is_heuristic": True,
                    }

    # Check informative take names next
    for tname in take_names:
        if tname.strip().lower() in generic_takes:
            continue
        for cat_name, cat_def in ordered_cats:
            if not isinstance(cat_def, dict):
                continue
            for raw_regex in cat_def.get("patterns", []):
                if re.search(raw_regex, tname, flags=re.IGNORECASE):
                    return {
                        "category": cat_name,
                        "source": "take_name_pattern",
                        "matched_pattern": raw_regex,
                        "is_heuristic": True,
                    }

    return {
        "category": default_cat,
        "source": "default_other",
        "matched_pattern": None,
        "is_heuristic": True,
    }


# ---------------------------------------------------------------------------
# Scene -> Structured Analysis Report Builder
# ---------------------------------------------------------------------------


def _resolve_fps(scene: RawFBXScene) -> tuple[float, str]:
    if scene.time_mode is not None:
        if scene.time_mode == 13 and scene.custom_frame_rate and scene.custom_frame_rate > 0:
            return round(scene.custom_frame_rate, 6), "GlobalSettings.CustomFrameRate"
        if scene.time_mode == 0 and scene.custom_frame_rate and scene.custom_frame_rate > 0:
            return round(scene.custom_frame_rate, 6), "GlobalSettings.CustomFrameRate"
        mapped = FBX_TIMEMODE_FPS.get(scene.time_mode)
        if mapped and mapped > 0:
            return mapped, f"GlobalSettings.TimeMode({scene.time_mode})"
    if scene.custom_frame_rate and scene.custom_frame_rate > 0:
        return round(scene.custom_frame_rate, 6), "GlobalSettings.CustomFrameRate"
    return 30.0, "default_30fps"


def _build_report_from_scene(
    scene: RawFBXScene,
    *,
    fbx_path: Path,
    rel_path: str,
    file_size: int,
    sha256: str,
    animation_rules: dict[str, Any] | None,
) -> dict[str, Any]:
    fps, fps_source = _resolve_fps(scene)

    # Reconstruct connections
    parent_map: dict[int, int] = {}
    model_attr_subtype: dict[int, str] = {}
    cluster_bone_ids: set[int] = set()
    stack_to_layers: dict[int, list[int]] = {}
    layer_to_curnodes: dict[int, list[int]] = {}
    curnode_to_curves: dict[int, list[int]] = {}
    animated_model_ids: set[int] = set()

    for child_id, parent_id in scene.connections:
        if child_id in scene.models and (parent_id in scene.models or parent_id == 0):
            parent_map[child_id] = parent_id
        if child_id in scene.node_attr_subtypes and parent_id in scene.models:
            model_attr_subtype[parent_id] = scene.node_attr_subtypes[child_id]
        if child_id in scene.models and parent_id in scene.cluster_ids:
            cluster_bone_ids.add(child_id)
        if child_id in scene.anim_layers and parent_id in scene.anim_stacks:
            stack_to_layers.setdefault(parent_id, []).append(child_id)
        if child_id in scene.anim_curve_nodes and parent_id in scene.anim_layers:
            layer_to_curnodes.setdefault(parent_id, []).append(child_id)
        if child_id in scene.anim_curves and parent_id in scene.anim_curve_nodes:
            curnode_to_curves.setdefault(parent_id, []).append(child_id)
        if child_id in scene.anim_curve_nodes and parent_id in scene.models:
            animated_model_ids.add(parent_id)

    # Identify skeleton bone Model nodes
    bone_subtypes = {"LimbNode", "Root", "Skeleton"}
    bone_models: dict[int, ParsedModel] = {}
    for mid, m in scene.models.items():
        attr_sub = model_attr_subtype.get(mid, "")
        if m.subtype in bone_subtypes or attr_sub in bone_subtypes or mid in cluster_bone_ids:
            bone_models[mid] = m

    # Also include Null/Armature ancestors/descendants within a skeletal chain if bones exist
    if bone_models:
        for mid, m in scene.models.items():
            if mid not in bone_models and m.subtype in ("Null", "") and mid in animated_model_ids:
                # Check if connected to bone hierarchy
                p = parent_map.get(mid)
                if p in bone_models:
                    bone_models[mid] = m

    root_bones: list[str] = []
    for mid, m in bone_models.items():
        p = parent_map.get(mid)
        if p is None or p == 0 or p not in bone_models:
            root_bones.append(m.name)

    # Assemble animation takes with exact curve & keyframe bounds
    takes: list[dict[str, Any]] = []
    takes_by_name_fallback = {t.name: t for t in scene.takes_section}

    for stack_id, stack in scene.anim_stacks.items():
        curve_ids: set[int] = set()
        for lid in stack_to_layers.get(stack_id, []):
            for cn_id in layer_to_curnodes.get(lid, []):
                for cid in curnode_to_curves.get(cn_id, []):
                    curve_ids.add(cid)

        curve_objs = [scene.anim_curves[cid] for cid in curve_ids if cid in scene.anim_curves]
        key_count = sum(c.key_count for c in curve_objs)
        min_ktimes = [c.min_ktime for c in curve_objs if c.min_ktime is not None]
        max_ktimes = [c.max_ktime for c in curve_objs if c.max_ktime is not None]

        fb_take = takes_by_name_fallback.get(stack.name)

        start_kt: int | None = None
        stop_kt: int | None = None
        if min_ktimes and max_ktimes:
            start_kt = min(min_ktimes)
            stop_kt = max(max_ktimes)
        if stack.local_start_ktime is not None and stack.local_stop_ktime is not None:
            if start_kt is None or (stack.local_stop_ktime > stack.local_start_ktime):
                # Prefer explicit LocalStart/LocalStop unless LocalStop <= LocalStart and curves span wider
                if start_kt is None or stack.local_stop_ktime >= stop_kt:  # type: ignore[operator]
                    start_kt = stack.local_start_ktime
                    stop_kt = stack.local_stop_ktime
        elif fb_take and fb_take.start_ktime is not None and fb_take.stop_ktime is not None:
            start_kt = fb_take.start_ktime
            stop_kt = fb_take.stop_ktime

        start_sec = round((start_kt or 0) / FBX_KTIME_ONE_SECOND, 6)
        end_sec = round((stop_kt or 0) / FBX_KTIME_ONE_SECOND, 6)
        if end_sec < start_sec:
            end_sec = start_sec
        dur_sec = round(max(0.0, end_sec - start_sec), 6)

        start_frame = round(start_sec * fps, 3)
        end_frame = round(end_sec * fps, 3)
        if start_frame.is_integer():
            start_frame = int(start_frame)
        if end_frame.is_integer():
            end_frame = int(end_frame)
        # Ensure at least 1 frame span if keys exist at a single pose or very short clip
        if key_count > 0 and end_frame <= start_frame:
            end_frame = (int(start_frame) if isinstance(start_frame, int) else start_frame) + 1
        frame_count = max(0, int(round((end_sec - start_sec) * fps)))
        if key_count > 0 and frame_count == 0:
            frame_count = 1

        takes.append(
            {
                "name": stack.name,
                "start_time_sec": start_sec,
                "end_time_sec": end_sec,
                "duration_sec": dur_sec,
                "start_frame": start_frame,
                "end_frame": end_frame,
                "frame_count": frame_count,
                "curve_count": len(curve_objs),
                "keyframe_count": key_count,
            }
        )

    # Fallback to legacy `Takes` section if no AnimationStack objects existed (FBX 6.x)
    if not takes and scene.takes_section:
        for fb in scene.takes_section:
            start_sec = round((fb.start_ktime or 0) / FBX_KTIME_ONE_SECOND, 6)
            end_sec = round((fb.stop_ktime or 0) / FBX_KTIME_ONE_SECOND, 6)
            if end_sec < start_sec:
                end_sec = start_sec
            dur_sec = round(max(0.0, end_sec - start_sec), 6)
            sf = int(round(start_sec * fps))
            ef = int(round(end_sec * fps))
            if (dur_sec > 0 or fb.has_inline_keys) and ef <= sf:
                ef = sf + 1
            takes.append(
                {
                    "name": fb.name,
                    "start_time_sec": start_sec,
                    "end_time_sec": end_sec,
                    "duration_sec": dur_sec,
                    "start_frame": sf,
                    "end_frame": ef,
                    "frame_count": max(0, ef - sf),
                    "curve_count": 1 if fb.has_inline_keys else 0,
                    "keyframe_count": 2 if fb.has_inline_keys else 0,
                }
            )

    total_curves = len(scene.anim_curves)
    total_keyframes = sum(c.key_count for c in scene.anim_curves.values())
    has_nonempty_take = any(
        t["keyframe_count"] > 0 or t["curve_count"] > 0 or t["duration_sec"] > 0 for t in takes
    )
    has_animation = bool(has_nonempty_take or total_keyframes > 0)

    has_mesh = len(scene.meshes) > 0
    total_vertices = sum(scene.meshes.values())
    has_skeleton = len(bone_models) > 0

    rig_info = classify_rig(bone_models, scene.models, parent_map, animated_model_ids)
    category_info = classify_animation_category(
        rel_path=rel_path,
        fbx_path=fbx_path,
        take_names=[t["name"] for t in takes],
        animation_rules=animation_rules,
    )

    errors: list[str] = []
    warnings: list[str] = list(scene.warnings)
    error_code: str | None = None
    is_valid = True

    if not has_animation:
        is_valid = False
        error_code = "NO_ANIMATION_DATA"
        if has_mesh:
            errors.append(
                "FBX contains mesh geometry without animation keyframes/takes. "
                "Character or static model uploads are outside the animation-only repository scope."
            )
        else:
            errors.append("FBX contains no animation takes or keyframe curves.")

    if has_mesh and has_animation:
        warnings.append(
            f"FBX embeds {len(scene.meshes)} mesh geometry node(s) ({total_vertices} vertices) "
            "alongside animation data; importer configuration will disable material/geometry extras."
        )

    if rig_info["rig_type"] == "Unknown" and has_animation:
        warnings.append(rig_info["reason"])

    primary_duration = max((t["duration_sec"] for t in takes), default=0.0)
    total_frames = max((t["frame_count"] for t in takes), default=0)

    major = scene.fbx_version // 1000
    minor = (scene.fbx_version % 1000) // 100

    return {
        "file_path": rel_path,
        "file_name": fbx_path.name,
        "file_size_bytes": file_size,
        "sha256": sha256,
        "is_valid": is_valid,
        "error_code": error_code,
        "errors": errors,
        "warnings": warnings,
        "fbx_format": scene.fbx_format,
        "fbx_version": scene.fbx_version,
        "fbx_version_label": f"{major}.{minor}",
        "creator": scene.creator,
        "application": scene.application,
        "frame_rate": fps,
        "frame_rate_source": fps_source,
        "has_animation": has_animation,
        "animation_curve_count": total_curves,
        "total_keyframe_count": total_keyframes,
        "primary_duration_sec": primary_duration,
        "total_frame_count": total_frames,
        "takes": takes,
        "has_mesh": has_mesh,
        "mesh_count": len(scene.meshes),
        "total_vertex_count": total_vertices,
        "mesh_names": scene.mesh_names[:32],
        "has_skeleton": has_skeleton,
        "bone_count": len(bone_models),
        "root_bones": root_bones,
        "bone_names": [m.name for m in bone_models.values()][:128],
        "animated_node_count": len(animated_model_ids),
        "rig_classification": rig_info,
        "animation_category": category_info,
    }


def _enrich_with_blender(fbx_path: Path, report: dict[str, Any], blender_bin: str) -> None:
    """Optional headless Blender inspection enrichment when Blender is installed and requested."""
    py_snippet = (
        "import bpy, json, sys\n"
        "bpy.ops.wm.read_factory_settings(use_empty=True)\n"
        "fbx_file = sys.argv[-1]\n"
        "bpy.ops.import_scene.fbx(filepath=fbx_file)\n"
        "actions = [{'name': a.name, 'frame_range': [float(a.frame_range[0]), float(a.frame_range[1])], 'fcurves': len(a.fcurves)} for a in bpy.data.actions]\n"
        "armatures = [{'name': o.name, 'bones': [b.name for b in o.data.bones]} for o in bpy.data.objects if o.type == 'ARMATURE']\n"
        "meshes = [o.name for o in bpy.data.objects if o.type == 'MESH']\n"
        "print('BLENDER_JSON:' + json.dumps({'actions': actions, 'armatures': armatures, 'meshes': meshes}))\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as tf:
        tf.write(py_snippet)
        script_path = tf.name
    try:
        proc = subprocess.run(
            [blender_bin, "--background", "--factory-startup", "--python", script_path, "--", str(fbx_path)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        for line in proc.stdout.splitlines():
            if line.startswith("BLENDER_JSON:"):
                report["blender_inspection"] = json.loads(line[len("BLENDER_JSON:") :])
                return
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        report.setdefault("warnings", []).append(f"Optional Blender inspection skipped: {exc}")
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass


def analyze_fbx_file(
    fbx_path: Path | str,
    *,
    repo_root: Path | str | None = None,
    animation_rules: dict[str, Any] | None = None,
    use_blender: bool = False,
) -> dict[str, Any]:
    """Inspect a single FBX file and return a structured machine-readable analysis report."""
    path = Path(fbx_path)
    rel_path = (
        normalize_rel_path(path, repo_root)
        if repo_root is not None
        else normalize_unicode(path.as_posix())
    )

    base_failure = {
        "file_path": rel_path,
        "file_name": path.name,
        "file_size_bytes": 0,
        "sha256": "",
        "is_valid": False,
        "error_code": "UNREADABLE_FILE",
        "errors": [],
        "warnings": [],
        "fbx_format": None,
        "fbx_version": None,
        "fbx_version_label": None,
        "creator": "",
        "application": "",
        "frame_rate": None,
        "frame_rate_source": None,
        "has_animation": False,
        "animation_curve_count": 0,
        "total_keyframe_count": 0,
        "primary_duration_sec": 0.0,
        "total_frame_count": 0,
        "takes": [],
        "has_mesh": False,
        "mesh_count": 0,
        "total_vertex_count": 0,
        "mesh_names": [],
        "has_skeleton": False,
        "bone_count": 0,
        "root_bones": [],
        "bone_names": [],
        "animated_node_count": 0,
        "rig_classification": {
            "rig_type": "Unknown",
            "confidence": 0.0,
            "matched_humanoid_bones": {},
            "missing_required_humanoid_bones": list(REQUIRED_HUMANOID_BONES),
            "has_extra_root": False,
            "hierarchy_valid": False,
            "reason": "FBX file could not be parsed.",
        },
        "animation_category": {
            "category": "Other",
            "source": "invalid_file",
            "matched_pattern": None,
            "is_heuristic": True,
        },
    }

    if not path.exists() or not path.is_file():
        base_failure["error_code"] = "FILE_NOT_FOUND"
        base_failure["errors"] = [f"FBX file does not exist: {rel_path}"]
        return base_failure

    try:
        file_size = path.stat().st_size
    except OSError as exc:
        base_failure["errors"] = [f"Cannot stat FBX file: {exc}"]
        return base_failure

    base_failure["file_size_bytes"] = file_size
    if file_size == 0:
        base_failure["error_code"] = "EMPTY_FILE"
        base_failure["errors"] = ["FBX file is empty (0 bytes)."]
        return base_failure

    sha256 = compute_sha256(path)
    base_failure["sha256"] = sha256

    try:
        with open(path, "rb") as fh:
            prefix = fh.read(512)
            if prefix.startswith(b"version https://git-lfs.github.com/spec/v1"):
                base_failure["error_code"] = "GIT_LFS_POINTER"
                base_failure["errors"] = [
                    "File is an unresolved Git LFS pointer rather than actual FBX content. "
                    "Ensure git-lfs is installed and checkout uses `lfs: true`."
                ]
                return base_failure

            fh.seek(0)
            if prefix.startswith(b"Kaydara FBX Binary"):
                scene = parse_binary_fbx(fh, file_size)
            else:
                # Check if plausible ASCII FBX text
                if b"\x00" in prefix[:128]:
                    raise FBXFormatError(
                        "INVALID_FBX_HEADER",
                        "Binary file does not start with 'Kaydara FBX Binary' magic header.",
                    )
                text_head = prefix.decode("utf-8", errors="replace")
                if (
                    "FBX" not in text_head
                    and "FBXHeaderExtension" not in text_head
                    and "Objects:" not in text_head
                ):
                    raise FBXFormatError(
                        "INVALID_FBX_HEADER",
                        "File is neither a Kaydara Binary FBX nor an Autodesk ASCII FBX file.",
                    )
                if file_size > 128 * 1024 * 1024:
                    raise FBXFormatError(
                        "FILE_TOO_LARGE_ASCII",
                        f"ASCII FBX exceeds safe in-memory limit ({file_size} bytes); export as Binary FBX.",
                    )
                full_text = path.read_text(encoding="utf-8", errors="replace")
                scene = parse_ascii_fbx(full_text)

        report = _build_report_from_scene(
            scene,
            fbx_path=path,
            rel_path=rel_path,
            file_size=file_size,
            sha256=sha256,
            animation_rules=animation_rules,
        )

        if use_blender:
            blender_bin = os.environ.get("BLENDER_EXECUTABLE") or shutil.which("blender")
            if blender_bin:
                _enrich_with_blender(path, report, blender_bin)

        return report

    except FBXFormatError as exc:
        base_failure["error_code"] = exc.code
        base_failure["errors"] = [str(exc)]
        return base_failure
    except OSError as exc:
        base_failure["error_code"] = "IO_ERROR"
        base_failure["errors"] = [f"I/O error while reading FBX: {exc}"]
        return base_failure


# ---------------------------------------------------------------------------
# CLI Entrypoint
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Inspect FBX animation assets and generate a machine-readable report."
    )
    parser.add_argument(
        "target",
        nargs="?",
        default="animations",
        help="FBX file or directory of FBX files to analyze (default: animations)",
    )
    parser.add_argument(
        "--repo-root",
        default=".",
        help="Repository root directory (default: current directory)",
    )
    parser.add_argument(
        "--rules",
        default="config/animation_rules.json",
        help="Path to animation classification rules JSON",
    )
    parser.add_argument(
        "--output",
        default="reports/analysis_report.json",
        help="Output JSON report path (default: reports/analysis_report.json)",
    )
    parser.add_argument(
        "--use-blender",
        action="store_true",
        help="Optionally enrich inspection using headless Blender if installed",
    )
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    target_path = Path(args.target)
    if not target_path.is_absolute():
        target_path = (repo_root / target_path).resolve()

    rules_path = Path(args.rules)
    if not rules_path.is_absolute():
        rules_path = (repo_root / rules_path).resolve()
    animation_rules = load_json_config(rules_path) if rules_path.exists() else None

    fbx_files = [target_path] if target_path.is_file() else discover_fbx_files(target_path)

    reports: list[dict[str, Any]] = []
    valid_count = 0
    invalid_count = 0
    for fbx_file in fbx_files:
        rep = analyze_fbx_file(
            fbx_file,
            repo_root=repo_root,
            animation_rules=animation_rules,
            use_blender=args.use_blender,
        )
        reports.append(rep)
        if rep["is_valid"]:
            valid_count += 1
        else:
            invalid_count += 1

    payload = {
        "schema_version": 1,
        "total_fbx_files": len(reports),
        "valid_fbx_files": valid_count,
        "invalid_fbx_files": invalid_count,
        "files": reports,
    }

    out_path = Path(args.output)
    if not out_path.is_absolute():
        out_path = (repo_root / out_path).resolve()
    write_json_report(out_path, payload)

    print(
        f"Analyzed {len(reports)} FBX file(s): {valid_count} valid, {invalid_count} invalid -> {out_path}"
    )
    return 0 if invalid_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
