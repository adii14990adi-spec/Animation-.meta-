"""Synthetic Binary & ASCII FBX Animation Fixture Builder for Unit & Integration Tests.

Constructs structurally authentic Kaydara Binary FBX (v7400 32-bit and v7500 64-bit
with zlib-compressed KeyTime arrays) and Autodesk ASCII FBX files in memory without
depending on private user assets or external downloads.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from scripts.analyze_fbx import FBX_BINARY_MAGIC, FBX_KTIME_ONE_SECOND

# Standard Mixamo-style 17-bone Humanoid hierarchy (15 required + Chest + Neck)
MIXAMO_HUMANOID_HIERARCHY: list[tuple[str, str | None]] = [
    ("Armature", None),
    ("mixamorig:Hips", "Armature"),
    ("mixamorig:Spine", "mixamorig:Hips"),
    ("mixamorig:Spine1", "mixamorig:Spine"),
    ("mixamorig:Neck", "mixamorig:Spine1"),
    ("mixamorig:Head", "mixamorig:Neck"),
    ("mixamorig:LeftShoulder", "mixamorig:Spine1"),
    ("mixamorig:LeftArm", "mixamorig:LeftShoulder"),
    ("mixamorig:LeftForeArm", "mixamorig:LeftArm"),
    ("mixamorig:LeftHand", "mixamorig:LeftForeArm"),
    ("mixamorig:RightShoulder", "mixamorig:Spine1"),
    ("mixamorig:RightArm", "mixamorig:RightShoulder"),
    ("mixamorig:RightForeArm", "mixamorig:RightArm"),
    ("mixamorig:RightHand", "mixamorig:RightForeArm"),
    ("mixamorig:LeftUpLeg", "mixamorig:Hips"),
    ("mixamorig:LeftLeg", "mixamorig:LeftUpLeg"),
    ("mixamorig:LeftFoot", "mixamorig:LeftLeg"),
    ("mixamorig:RightUpLeg", "mixamorig:Hips"),
    ("mixamorig:RightLeg", "mixamorig:RightUpLeg"),
    ("mixamorig:RightFoot", "mixamorig:RightLeg"),
]

# Generic non-humanoid skeleton (e.g. Battle Royale weapon / supply crate / drone rig)
GENERIC_PROP_HIERARCHY: list[tuple[str, str | None]] = [
    ("CrateRoot", None),
    ("HingePivot", "CrateRoot"),
    ("LidBone", "HingePivot"),
    ("LatchLeft", "LidBone"),
    ("LatchRight", "LidBone"),
]


@dataclass
class BinProp:
    type_code: bytes
    payload: bytes

    def encode(self) -> bytes:
        return self.type_code + self.payload

    @staticmethod
    def i32(val: int) -> BinProp:
        return BinProp(b"I", struct.pack("<i", val))

    @staticmethod
    def i64(val: int) -> BinProp:
        return BinProp(b"L", struct.pack("<q", val))

    @staticmethod
    def f64(val: float) -> BinProp:
        return BinProp(b"D", struct.pack("<d", val))

    @staticmethod
    def string(val: str) -> BinProp:
        raw = val.encode("utf-8")
        return BinProp(b"S", struct.pack("<I", len(raw)) + raw)

    @staticmethod
    def obj_name(name: str, cls_name: str) -> BinProp:
        raw = name.encode("utf-8") + b"\x00\x01" + cls_name.encode("utf-8")
        return BinProp(b"S", struct.pack("<I", len(raw)) + raw)

    @staticmethod
    def i64_array(values: list[int], compress: bool = True) -> BinProp:
        raw = struct.pack(f"<{len(values)}q", *values) if values else b""
        if compress and values:
            comp = zlib.compress(raw)
            hdr = struct.pack("<III", len(values), 1, len(comp))
            return BinProp(b"l", hdr + comp)
        hdr = struct.pack("<III", len(values), 0, len(raw))
        return BinProp(b"l", hdr + raw)

    @staticmethod
    def f64_array(values: list[float], compress: bool = True) -> BinProp:
        raw = struct.pack(f"<{len(values)}d", *values) if values else b""
        if compress and values:
            comp = zlib.compress(raw)
            hdr = struct.pack("<III", len(values), 1, len(comp))
            return BinProp(b"d", hdr + comp)
        hdr = struct.pack("<III", len(values), 0, len(raw))
        return BinProp(b"d", hdr + raw)


@dataclass
class BinNode:
    name: str
    props: list[BinProp] = field(default_factory=list)
    children: list[BinNode] = field(default_factory=list)

    def serialize(self, start_offset: int, is_64bit: bool) -> bytes:
        name_bytes = self.name.encode("utf-8")
        hdr_len = (25 if is_64bit else 13) + len(name_bytes)
        prop_bytes = b"".join(p.encode() for p in self.props)
        cur_offset = start_offset + hdr_len + len(prop_bytes)

        child_chunks: list[bytes] = []
        if self.children:
            for ch in self.children:
                chunk = ch.serialize(cur_offset, is_64bit=is_64bit)
                child_chunks.append(chunk)
                cur_offset += len(chunk)
            sentinel = b"\x00" * (25 if is_64bit else 13)
            child_chunks.append(sentinel)
            cur_offset += len(sentinel)

        end_offset = cur_offset
        if is_64bit:
            header = struct.pack(
                "<QQQB", end_offset, len(self.props), len(prop_bytes), len(name_bytes)
            )
        else:
            header = struct.pack(
                "<IIIB", end_offset, len(self.props), len(prop_bytes), len(name_bytes)
            )
        return header + name_bytes + prop_bytes + b"".join(child_chunks)


def _prop70_int(name: str, type_label: str, val: int) -> BinNode:
    return BinNode(
        "P",
        [
            BinProp.string(name),
            BinProp.string(type_label),
            BinProp.string(""),
            BinProp.string(""),
            BinProp.i32(val),
        ],
    )


def _prop70_ktime(name: str, val: int) -> BinNode:
    return BinNode(
        "P",
        [
            BinProp.string(name),
            BinProp.string("KTime"),
            BinProp.string("Time"),
            BinProp.string(""),
            BinProp.i64(val),
        ],
    )


def _prop70_double(name: str, val: float) -> BinNode:
    return BinNode(
        "P",
        [
            BinProp.string(name),
            BinProp.string("double"),
            BinProp.string("Number"),
            BinProp.string(""),
            BinProp.f64(val),
        ],
    )


def build_synthetic_binary_fbx(
    *,
    version: int = 7400,
    fps: float = 30.0,
    time_mode: int = 6,
    bone_hierarchy: list[tuple[str, str | None]] | None = None,
    takes: list[tuple[str, int, int, int]] | None = None,
    include_mesh: bool = False,
    compress_arrays: bool = True,
) -> bytes:
    """Build valid Kaydara Binary FBX bytes.

    Args:
        version: FBX version (e.g. 7400 for 32-bit, 7500 for 64-bit).
        fps: Frame rate in frames/second.
        time_mode: FBX GlobalSettings TimeMode (6 = 30fps, 13 = CustomFrameRate).
        bone_hierarchy: List of `(bone_name, parent_bone_name_or_None)`.
        takes: List of `(take_name, start_frame, end_frame, key_count)`. Pass `[]` for static non-animated FBX.
        include_mesh: Whether to include a Mesh Geometry + Mesh Model object.
        compress_arrays: Whether to zlib-compress KeyTime and Vertices arrays.
    """
    if bone_hierarchy is None:
        bone_hierarchy = MIXAMO_HUMANOID_HIERARCHY
    if takes is None:
        takes = [("mixamo.com", 0, 30, 31)]

    is_64bit = version >= 7500
    next_id = 1000

    def alloc_id() -> int:
        nonlocal next_id
        next_id += 1
        return next_id

    header_ext = BinNode(
        "FBXHeaderExtension",
        children=[
            BinNode("FBXVersion", [BinProp.i32(version)]),
            BinNode("Creator", [BinProp.string("SyntheticFBXBuilder 1.0")]),
        ],
    )

    global_settings = BinNode(
        "GlobalSettings",
        children=[
            BinNode(
                "Properties70",
                children=[
                    _prop70_int("TimeMode", "enum", time_mode),
                    _prop70_double("CustomFrameRate", fps),
                ],
            )
        ],
    )

    objects_children: list[BinNode] = []
    connections_children: list[BinNode] = []

    bone_name_to_id: dict[str, int] = {}
    first_bone_id: int | None = None
    for b_name, parent_name in bone_hierarchy:
        mid = alloc_id()
        attr_id = alloc_id()
        bone_name_to_id[b_name] = mid
        if first_bone_id is None:
            first_bone_id = mid

        subtype = "Null" if parent_name is None and b_name == "Armature" else "LimbNode"
        objects_children.append(
            BinNode("NodeAttribute", [BinProp.i64(attr_id), BinProp.obj_name(b_name, "NodeAttribute"), BinProp.string(subtype)])
        )
        objects_children.append(
            BinNode("Model", [BinProp.i64(mid), BinProp.obj_name(b_name, "Model"), BinProp.string(subtype)])
        )
        connections_children.append(
            BinNode("C", [BinProp.string("OO"), BinProp.i64(attr_id), BinProp.i64(mid)])
        )
        parent_id = bone_name_to_id.get(parent_name, 0) if parent_name else 0
        connections_children.append(
            BinNode("C", [BinProp.string("OO"), BinProp.i64(mid), BinProp.i64(parent_id)])
        )

    if include_mesh:
        geom_id = alloc_id()
        mesh_model_id = alloc_id()
        verts = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        objects_children.append(
            BinNode(
                "Geometry",
                [BinProp.i64(geom_id), BinProp.obj_name("PreviewBody", "Geometry"), BinProp.string("Mesh")],
                children=[BinNode("Vertices", [BinProp.f64_array(verts, compress=compress_arrays)])],
            )
        )
        objects_children.append(
            BinNode("Model", [BinProp.i64(mesh_model_id), BinProp.obj_name("PreviewBody", "Model"), BinProp.string("Mesh")])
        )
        connections_children.append(
            BinNode("C", [BinProp.string("OO"), BinProp.i64(geom_id), BinProp.i64(mesh_model_id)])
        )
        connections_children.append(
            BinNode("C", [BinProp.string("OO"), BinProp.i64(mesh_model_id), BinProp.i64(0)])
        )

    takes_children: list[BinNode] = []
    target_anim_model_id = first_bone_id
    if target_anim_model_id is None and takes:
        # Unknown-rig case: create a plain camera/helper node to attach curves to if requested
        pass

    for take_name, start_frame, end_frame, key_count in takes:
        start_kt = int(round((start_frame / fps) * FBX_KTIME_ONE_SECOND))
        stop_kt = int(round((end_frame / fps) * FBX_KTIME_ONE_SECOND))
        stack_id = alloc_id()
        layer_id = alloc_id()

        objects_children.append(
            BinNode(
                "AnimationStack",
                [BinProp.i64(stack_id), BinProp.obj_name(take_name, "AnimStack"), BinProp.string("")],
                children=[
                    BinNode(
                        "Properties70",
                        children=[
                            _prop70_ktime("LocalStart", start_kt),
                            _prop70_ktime("LocalStop", stop_kt),
                            _prop70_ktime("ReferenceStart", start_kt),
                            _prop70_ktime("ReferenceStop", stop_kt),
                        ],
                    )
                ],
            )
        )
        objects_children.append(
            BinNode("AnimationLayer", [BinProp.i64(layer_id), BinProp.obj_name("BaseLayer", "AnimLayer"), BinProp.string("")])
        )
        connections_children.append(
            BinNode("C", [BinProp.string("OO"), BinProp.i64(layer_id), BinProp.i64(stack_id)])
        )

        if key_count > 0:
            cnode_id = alloc_id()
            curve_id = alloc_id()
            if key_count == 1:
                ktimes = [start_kt]
            else:
                step = (stop_kt - start_kt) / max(1, key_count - 1)
                ktimes = [int(round(start_kt + idx * step)) for idx in range(key_count)]

            objects_children.append(
                BinNode("AnimationCurveNode", [BinProp.i64(cnode_id), BinProp.obj_name("R", "AnimCurveNode"), BinProp.string("")])
            )
            objects_children.append(
                BinNode(
                    "AnimationCurve",
                    [BinProp.i64(curve_id), BinProp.obj_name("", "AnimCurve"), BinProp.string("")],
                    children=[BinNode("KeyTime", [BinProp.i64_array(ktimes, compress=compress_arrays)])],
                )
            )
            connections_children.append(
                BinNode("C", [BinProp.string("OO"), BinProp.i64(cnode_id), BinProp.i64(layer_id)])
            )
            connections_children.append(
                BinNode("C", [BinProp.string("OP"), BinProp.i64(curve_id), BinProp.i64(cnode_id), BinProp.string("d|X")])
            )
            if target_anim_model_id is not None:
                connections_children.append(
                    BinNode("C", [BinProp.string("OP"), BinProp.i64(cnode_id), BinProp.i64(target_anim_model_id), BinProp.string("Lcl Rotation")])
                )

        takes_children.append(
            BinNode(
                "Take",
                [BinProp.string(take_name)],
                children=[BinNode("LocalTime", [BinProp.i64(start_kt), BinProp.i64(stop_kt)])],
            )
        )

    top_sections = [
        header_ext,
        global_settings,
        BinNode("Objects", children=objects_children),
        BinNode("Connections", children=connections_children),
        BinNode("Takes", children=takes_children),
    ]

    buf = bytearray(FBX_BINARY_MAGIC + struct.pack("<I", version))
    for sec in top_sections:
        chunk = sec.serialize(len(buf), is_64bit=is_64bit)
        buf.extend(chunk)
    buf.extend(b"\x00" * (25 if is_64bit else 13))
    return bytes(buf)


def build_synthetic_ascii_fbx(
    *,
    version: int = 7400,
    fps: float = 24.0,
    time_mode: int = 10,
    bone_hierarchy: list[tuple[str, str | None]] | None = None,
    take_name: str = "Take 001",
    start_frame: int = 0,
    end_frame: int = 24,
) -> str:
    """Build valid Autodesk ASCII FBX text."""
    if bone_hierarchy is None:
        bone_hierarchy = MIXAMO_HUMANOID_HIERARCHY

    start_kt = int(round((start_frame / fps) * FBX_KTIME_ONE_SECOND))
    stop_kt = int(round((end_frame / fps) * FBX_KTIME_ONE_SECOND))
    mid_kt = (start_kt + stop_kt) // 2

    lines = [
        f"; FBX {version // 1000}.{(version % 1000) // 100}.0 project file",
        "FBXHeaderExtension:  {",
        f"\tFBXVersion: {version}",
        '\tCreator: "SyntheticASCIIBuilder 1.0"',
        "}",
        "GlobalSettings:  {",
        "\tProperties70:  {",
        f'\t\tP: "TimeMode", "enum", "", "",{time_mode}',
        f'\t\tP: "CustomFrameRate", "double", "Number", "",{fps}',
        "\t}",
        "}",
        "Objects:  {",
    ]

    bone_ids: dict[str, int] = {}
    conns: list[tuple[str, int, int]] = []
    cur_id = 2000
    for bname, pname in bone_hierarchy:
        cur_id += 1
        mid = cur_id
        cur_id += 1
        aid = cur_id
        bone_ids[bname] = mid
        subtype = "LimbNode"
        lines.append(f'\tNodeAttribute: {aid}, "NodeAttribute::{bname}", "{subtype}" {{')
        lines.append("\t}")
        lines.append(f'\tModel: {mid}, "Model::{bname}", "{subtype}" {{')
        lines.append("\t}")
        conns.append(("OO", aid, mid))
        pid = bone_ids.get(pname, 0) if pname else 0
        conns.append(("OO", mid, pid))

    stack_id = 9001
    layer_id = 9002
    cnode_id = 9003
    curve_id = 9004
    lines.extend(
        [
            f'\tAnimationStack: {stack_id}, "AnimStack::{take_name}", "" {{',
            "\t\tProperties70:  {",
            f'\t\t\tP: "LocalStart", "KTime", "Time", "",{start_kt}',
            f'\t\t\tP: "LocalStop", "KTime", "Time", "",{stop_kt}',
            "\t\t}",
            "\t}",
            f'\tAnimationLayer: {layer_id}, "AnimLayer::BaseLayer", "" {{',
            "\t}",
            f'\tAnimationCurveNode: {cnode_id}, "AnimCurveNode::R", "" {{',
            "\t}",
            f'\tAnimationCurve: {curve_id}, "AnimCurve::", "" {{',
            "\t\tKeyTime: *3 {",
            f"\t\t\ta: {start_kt},{mid_kt},{stop_kt}",
            "\t\t}",
            "\t}",
            "}",
            "Connections:  {",
        ]
    )
    for ctype, cid, pid in conns:
        lines.append(f'\tC: "{ctype}",{cid},{pid}')
    lines.append(f'\tC: "OO",{layer_id},{stack_id}')
    lines.append(f'\tC: "OO",{cnode_id},{layer_id}')
    lines.append(f'\tC: "OP",{curve_id},{cnode_id}, "d|X"')
    if bone_ids:
        first_mid = next(iter(bone_ids.values()))
        lines.append(f'\tC: "OP",{cnode_id},{first_mid}, "Lcl Rotation"')
    lines.extend(
        [
            "}",
            "Takes:  {",
            f'\tTake: "{take_name}" {{',
            f"\t\tLocalTime: {start_kt},{stop_kt}",
            "\t}",
            "}",
            "",
        ]
    )
    return "\n".join(lines)


def write_fbx(path: Path, data: bytes | str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(data, encoding="utf-8")
    return path
