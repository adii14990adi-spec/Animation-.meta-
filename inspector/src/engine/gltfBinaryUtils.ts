export interface GltfJson {
  asset?: {
    version?: string;
    minVersion?: string;
    generator?: string;
    copyright?: string;
  };
  scene?: number;
  scenes?: Array<{ name?: string; nodes?: number[] }>;
  nodes?: Array<{
    name?: string;
    children?: number[];
    mesh?: number;
    skin?: number;
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    matrix?: number[];
  }>;
  meshes?: Array<{
    name?: string;
    primitives?: Array<{
      attributes?: Record<string, number>;
      indices?: number;
      material?: number;
      mode?: number;
    }>;
  }>;
  skins?: Array<{
    name?: string;
    inverseBindMatrices?: number;
    skeleton?: number;
    joints?: number[];
  }>;
  buffers?: Array<{
    name?: string;
    uri?: string;
    byteLength?: number;
  }>;
  bufferViews?: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    target?: number;
  }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
    min?: number[];
    max?: number[];
    sparse?: {
      count: number;
      indices: {
        bufferView: number;
        byteOffset?: number;
        componentType: number;
      };
      values: {
        bufferView: number;
        byteOffset?: number;
      };
    };
  }>;
  images?: Array<{
    name?: string;
    uri?: string;
    mimeType?: string;
    bufferView?: number;
  }>;
  textures?: Array<{
    name?: string;
    source?: number;
    sampler?: number;
  }>;
  materials?: Array<{
    name?: string;
    [key: string]: unknown;
  }>;
}

export const COMPONENT_TYPE_NAMES: Record<number, string> = {
  5120: 'BYTE (5120)',
  5121: 'UNSIGNED_BYTE (5121)',
  5122: 'SHORT (5122)',
  5123: 'UNSIGNED_SHORT (5123)',
  5125: 'UNSIGNED_INT (5125)',
  5126: 'FLOAT (5126)',
};

export const COMPONENT_BYTE_SIZES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

export const TYPE_COMPONENT_COUNTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export function normalizePosixPath(rawPath: string): string {
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }
  const unified = decoded.replace(/\\/g, '/').trim();
  const segments = unified.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

export function getFileRelativePath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (rel && rel.trim().length > 0) {
    return normalizePosixPath(rel);
  }
  return normalizePosixPath(file.name);
}

export function dirnamePosix(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

export function basenamePosix(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Strip a trailing image-format infix from a filename stem, e.g.
 * "T_Hair_1_Normal_png" -> "T_Hair_1_Normal". Blender's glTF exporter
 * sometimes appends the format ("_png") to the original stem, producing
 * URIs like "T_Hair_1_Normal_png.png" while the uploaded file is named
 * "T_Hair_1_Normal.png". This normalisation is ONLY used for the
 * transparent near-match fallback and is always reported in the report.
 */
function stripFormatInfixStem(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  const stem = dotIdx === -1 ? lower : lower.slice(0, dotIdx);
  const ext = dotIdx === -1 ? '' : lower.slice(dotIdx);
  const stripped = stem.replace(/_(png|jpe?g|webp|bmp|gif|tga|dds|ktx2)$/i, '');
  return stripped + ext;
}

export function resolveUploadedResource(
  uri: string,
  gltfDir: string,
  files: File[],
): {
  file: File | null;
  mode: 'exact_path' | 'basename_fallback' | 'near_match' | 'missing';
  ambiguousNames?: string[];
} {
  const cleanUri = uri.split('?')[0].split('#')[0];
  const expectedRel = normalizePosixPath(
    gltfDir ? `${gltfDir}/${cleanUri}` : cleanUri,
  );
  const expectedNoRootFolder = normalizePosixPath(cleanUri);

  for (const f of files) {
    const fRel = getFileRelativePath(f);
    if (fRel === expectedRel || fRel === expectedNoRootFolder) {
      return { file: f, mode: 'exact_path' };
    }
  }
  for (const f of files) {
    const fRelLower = getFileRelativePath(f).toLowerCase();
    if (
      fRelLower === expectedRel.toLowerCase() ||
      fRelLower === expectedNoRootFolder.toLowerCase()
    ) {
      return { file: f, mode: 'exact_path' };
    }
  }

  // Basename fallback for Android Chrome flat multi-file picker
  const targetBase = basenamePosix(expectedNoRootFolder).toLowerCase();
  const baseMatches = files.filter(
    (f) => basenamePosix(getFileRelativePath(f)).toLowerCase() === targetBase,
  );
  if (baseMatches.length === 1) {
    return { file: baseMatches[0], mode: 'basename_fallback' };
  }
  if (baseMatches.length > 1) {
    return {
      file: null,
      mode: 'missing',
      ambiguousNames: baseMatches.map((m) => getFileRelativePath(m)),
    };
  }

  // Near-match fallback: same basename after stripping a trailing
  // format infix ("_png" etc.) from the stem. Reported transparently
  // as 'near_match' so filename discrepancies are never hidden.
  const targetStem = stripFormatInfixStem(targetBase);
  const nearMatches = files.filter(
    (f) => stripFormatInfixStem(basenamePosix(getFileRelativePath(f)).toLowerCase()) === targetStem,
  );
  if (nearMatches.length === 1) {
    return { file: nearMatches[0], mode: 'near_match' };
  }
  if (nearMatches.length > 1) {
    return {
      file: null,
      mode: 'missing',
      ambiguousNames: nearMatches.map((m) => getFileRelativePath(m)),
    };
  }

  return { file: null, mode: 'missing' };
}

export function decodeDataUri(uri: string): {
  bytes: Uint8Array;
  mimeType: string;
} {
  const commaIdx = uri.indexOf(',');
  if (!uri.startsWith('data:') || commaIdx === -1) {
    throw new Error('Malformed data URI.');
  }
  const header = uri.slice(5, commaIdx);
  const payload = uri.slice(commaIdx + 1);
  const parts = header.split(';');
  const mimeType = parts[0] || 'application/octet-stream';
  const isBase64 = parts.includes('base64');

  if (isBase64) {
    const cleaned = payload.replace(/\s+/g, '');
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { bytes, mimeType };
  }

  const decoded = decodeURIComponent(payload);
  const encoder = new TextEncoder();
  return { bytes: encoder.encode(decoded), mimeType };
}

export function inspectImageBytes(bytes: Uint8Array): {
  valid: boolean;
  format: string | null;
  width: number | null;
  height: number | null;
  error: string | null;
} {
  if (bytes.byteLength < 12) {
    return {
      valid: false,
      format: null,
      width: null,
      height: null,
      error: `Image file is truncated (${bytes.byteLength} bytes).`,
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    if (bytes.byteLength < 24) {
      return {
        valid: false,
        format: 'png',
        width: null,
        height: null,
        error: 'Truncated PNG header (missing IHDR dimensions).',
      };
    }
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width === 0 || height === 0) {
      return {
        valid: false,
        format: 'png',
        width,
        height,
        error: 'PNG image has invalid zero dimensions.',
      };
    }
    return { valid: true, format: 'png', width, height, error: null };
  }

  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 4 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const segLength = view.getUint16(offset + 2, false);
      if (segLength < 2 || offset + 2 + segLength > bytes.byteLength) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 9 <= bytes.byteLength) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        return { valid: width > 0 && height > 0, format: 'jpeg', width, height, error: null };
      }
      offset += 2 + segLength;
    }
    return { valid: true, format: 'jpeg', width: null, height: null, error: null };
  }

  // WebP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { valid: true, format: 'webp', width: null, height: null, error: null };
  }

  // GIF
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    return { valid: width > 0 && height > 0, format: 'gif', width, height, error: null };
  }

  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.byteLength >= 26) {
    const width = Math.abs(view.getInt32(18, true));
    const height = Math.abs(view.getInt32(22, true));
    return { valid: width > 0 && height > 0, format: 'bmp', width, height, error: null };
  }

  // KTX2
  if (bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58) {
    return { valid: true, format: 'ktx2', width: null, height: null, error: null };
  }

  return {
    valid: false,
    format: null,
    width: null,
    height: null,
    error: 'Unrecognized or corrupted image header bytes.',
  };
}

function readScalarComponent(
  view: DataView,
  byteOffset: number,
  componentType: number,
  normalized: boolean,
): number {
  switch (componentType) {
    case 5120: {
      const v = view.getInt8(byteOffset);
      return normalized ? Math.max(v / 127.0, -1.0) : v;
    }
    case 5121: {
      const v = view.getUint8(byteOffset);
      return normalized ? v / 255.0 : v;
    }
    case 5122: {
      const v = view.getInt16(byteOffset, true);
      return normalized ? Math.max(v / 32767.0, -1.0) : v;
    }
    case 5123: {
      const v = view.getUint16(byteOffset, true);
      return normalized ? v / 65535.0 : v;
    }
    case 5125: {
      const v = view.getUint32(byteOffset, true);
      return normalized ? v / 4294967295.0 : v;
    }
    case 5126:
      return view.getFloat32(byteOffset, true);
    default:
      throw new Error(`Unsupported glTF accessor componentType: ${componentType}`);
  }
}

export interface DecodedAccessorData {
  count: number;
  numComponents: number;
  componentType: number;
  type: string;
  values: Float64Array;
}

export function readGltfAccessor(
  gltf: GltfJson,
  accessorIndex: number,
  buffers: Map<number, Uint8Array>,
): DecodedAccessorData {
  const accessors = gltf.accessors ?? [];
  if (accessorIndex < 0 || accessorIndex >= accessors.length) {
    throw new Error(`Accessor index ${accessorIndex} out of bounds (total: ${accessors.length}).`);
  }
  const accessor = accessors[accessorIndex];
  const numComponents = TYPE_COMPONENT_COUNTS[accessor.type];
  if (!numComponents) {
    throw new Error(`Invalid accessor type "${String(accessor.type)}" on accessor #${accessorIndex}.`);
  }
  const compByteSize = COMPONENT_BYTE_SIZES[accessor.componentType];
  if (!compByteSize) {
    throw new Error(
      `Invalid accessor componentType "${String(accessor.componentType)}" on accessor #${accessorIndex}.`,
    );
  }

  const normalized = Boolean(accessor.normalized);
  const values = new Float64Array(accessor.count * numComponents);

  if (accessor.bufferView !== undefined) {
    const bufferViews = gltf.bufferViews ?? [];
    if (accessor.bufferView < 0 || accessor.bufferView >= bufferViews.length) {
      throw new Error(
        `Accessor #${accessorIndex} references invalid bufferView #${accessor.bufferView}.`,
      );
    }
    const bv = bufferViews[accessor.bufferView];
    const bufBytes = buffers.get(bv.buffer);
    if (!bufBytes) {
      throw new Error(
        `Buffer #${bv.buffer} required by accessor #${accessorIndex} is unavailable.`,
      );
    }

    const bvOffset = bv.byteOffset ?? 0;
    if (bvOffset < 0 || bvOffset + bv.byteLength > bufBytes.byteLength) {
      throw new Error(
        `BufferView #${accessor.bufferView} [${bvOffset}..${bvOffset + bv.byteLength}] exceeds buffer #${bv.buffer} byteLength (${bufBytes.byteLength}).`,
      );
    }

    const accOffset = accessor.byteOffset ?? 0;
    const elementByteSize = numComponents * compByteSize;
    const stride = bv.byteStride ?? elementByteSize;

    if (stride < elementByteSize) {
      throw new Error(
        `BufferView #${accessor.bufferView} byteStride (${stride}) is smaller than element size (${elementByteSize}).`,
      );
    }

    const requiredSpan =
      accessor.count === 0 ? 0 : accOffset + (accessor.count - 1) * stride + elementByteSize;
    if (accOffset < 0 || requiredSpan > bv.byteLength) {
      throw new Error(
        `Accessor #${accessorIndex} span (${requiredSpan} bytes) exceeds bufferView #${accessor.bufferView} byteLength (${bv.byteLength}).`,
      );
    }

    const view = new DataView(
      bufBytes.buffer,
      bufBytes.byteOffset + bvOffset,
      bv.byteLength,
    );

    for (let i = 0; i < accessor.count; i++) {
      const elemBase = accOffset + i * stride;
      for (let c = 0; c < numComponents; c++) {
        values[i * numComponents + c] = readScalarComponent(
          view,
          elemBase + c * compByteSize,
          accessor.componentType,
          normalized,
        );
      }
    }
  }

  if (accessor.sparse && accessor.sparse.count > 0) {
    const bufferViews = gltf.bufferViews ?? [];
    const idxBv = bufferViews[accessor.sparse.indices.bufferView];
    const valBv = bufferViews[accessor.sparse.values.bufferView];
    if (!idxBv || !valBv) {
      throw new Error(`Accessor #${accessorIndex} has invalid sparse bufferView references.`);
    }
    const idxBuf = buffers.get(idxBv.buffer);
    const valBuf = buffers.get(valBv.buffer);
    if (!idxBuf || !valBuf) {
      throw new Error(`Accessor #${accessorIndex} sparse buffers are unavailable.`);
    }
    const idxCompSize = COMPONENT_BYTE_SIZES[accessor.sparse.indices.componentType];
    if (!idxCompSize) {
      throw new Error(`Invalid sparse index componentType on accessor #${accessorIndex}.`);
    }
    const idxView = new DataView(
      idxBuf.buffer,
      idxBuf.byteOffset + (idxBv.byteOffset ?? 0),
      idxBv.byteLength,
    );
    const valView = new DataView(
      valBuf.buffer,
      valBuf.byteOffset + (valBv.byteOffset ?? 0),
      valBv.byteLength,
    );
    const idxOffset = accessor.sparse.indices.byteOffset ?? 0;
    const valOffset = accessor.sparse.values.byteOffset ?? 0;
    const elemSize = numComponents * compByteSize;

    for (let s = 0; s < accessor.sparse.count; s++) {
      const targetIndex = readScalarComponent(
        idxView,
        idxOffset + s * idxCompSize,
        accessor.sparse.indices.componentType,
        false,
      );
      if (targetIndex < 0 || targetIndex >= accessor.count) {
        throw new Error(
          `Sparse index ${targetIndex} out of bounds on accessor #${accessorIndex}.`,
        );
      }
      for (let c = 0; c < numComponents; c++) {
        values[targetIndex * numComponents + c] = readScalarComponent(
          valView,
          valOffset + s * elemSize + c * compByteSize,
          accessor.componentType,
          normalized,
        );
      }
    }
  }

  return {
    count: accessor.count,
    numComponents,
    componentType: accessor.componentType,
    type: accessor.type,
    values,
  };
}
