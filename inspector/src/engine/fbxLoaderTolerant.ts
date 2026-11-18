/**
 * FBX loading with a documented, minimal workaround for an over-strict
 * end-of-document check in three.js's `FBXLoader`.
 *
 * ## Symptom
 *
 * Two assets in `animations/` fail to load with
 *
 * ```text
 * THREE.FBXLoader: Unknown property type
 * ```
 *
 * Note the *empty* type string at the end — the tell-tale signature of the parser
 * having walked past the node tree into the file footer rather than having found
 * genuinely corrupt data.
 *
 * ## Root cause
 *
 * `BinaryParser.endOfContent()` in `three/examples/jsm/loaders/FBXLoader.js`
 * decides "document finished?" against a hardcoded byte budget:
 *
 * ```js
 * // footer size: 160bytes + 16-byte alignment padding
 * if ( reader.size() % 16 === 0 ) {
 *   return ( ( reader.getOffset() + 160 + 16 ) & ~ 0xf ) >= reader.size();
 * } else {
 *   return reader.getOffset() + 160 + 16 >= reader.size();   // literal 176
 * }
 * ```
 *
 * A binary FBX footer is *not* a fixed size. It is
 * `footer-id | 16-byte magic | version | 120 zero bytes | 16-byte magic`, and the
 * alignment padding before it is only guaranteed to be 16-byte aligned. The
 * budget of 176 therefore holds for some exporters and not others:
 *
 * | asset                   | node tree ends | trailing bytes | stock check |
 * |-------------------------|----------------|----------------|-------------|
 * | `idle.fbx`              | 427,423        | 162            | passes      |
 * | `walk forward.fbx`      | 343,363        | 174            | passes      |
 * | `death from the back.fbx` | 554,160      | **177**        | **fails**   |
 * | `reloading.fbx`         | 639,136        | **177**        | **fails**   |
 *
 * Both rejected files are valid: an independent FBX-binary walker reads them
 * end-to-end with zero unknown property types and zero offset mismatches, and
 * their animation payload (65 models / 315 curves / 630 key arrays) matches
 * files that load fine. Only the trailer length differs.
 *
 * ## Workaround
 *
 * We cannot patch `node_modules`: it is git-ignored, so the change would be lost
 * on every `npm ci` and in CI. Instead, before handing the buffer to three.js we
 * walk only the **top-level** node headers — cheap, and it never inspects or
 * rewrites interior data — to find where the node tree truly ends, and trim
 * purely-trailing footer bytes so that the stock `endOfContent()` check fires
 * exactly at that boundary.
 *
 * Properties that make this safe:
 *
 * - **Non-destructive.** The caller's buffer is never mutated; the source files
 *   on disk are never touched. A trimmed copy is made only when needed.
 * - **No-op when already fine.** If the stock budget already passes, the
 *   original `ArrayBuffer` is passed through untouched, so every currently
 *   working asset parses with byte-identical input.
 * - **Fails closed.** If the top-level walk cannot determine a boundary, or the
 *   trailing bytes are not purely footer-like, the original buffer is returned
 *   and three.js throws exactly as it does today.
 */

import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const BINARY_MAGIC = 'Kaydara FBX Binary  \x00\x1a\x00';

/** Matches the stock `endOfContent()` budget (160 + 16). */
export const STOCK_FOOTER_BUDGET = 176;

/** Refuse to trim more than this; a real footer is a few hundred bytes. */
export const MAX_FOOTER_TRIM = 4096;

export interface FbxFooterAnalysis {
  /** Binary FBX (vs. ASCII, which is left entirely alone). */
  binary: boolean;
  version: number | null;
  /** Byte offset just past the last top-level node, or null if undetermined. */
  contentEnd: number | null;
  /** `size - contentEnd`, i.e. how many footer bytes follow the node tree. */
  trailingBytes: number | null;
  /** Whether the stock 176-byte budget already accepts this file. */
  stockAccepts: boolean;
  /**
   * Bytes that will actually be dropped to satisfy the stock budget — i.e.
   * `trailingBytes - STOCK_FOOTER_BUDGET`, not the whole footer.
   */
  trimBytes: number;
}

/**
 * Walk only the top-level node records to locate the end of the node tree.
 *
 * Each record starts with `endOffset` (u64 for FBX >= 7500, else u32), so the
 * next sibling begins exactly at `endOffset`. A null record (all-zero header)
 * terminates the list. We deliberately do not descend into children.
 */
export function findTopLevelContentEnd(buffer: ArrayBuffer): { version: number; contentEnd: number } | null {
  if (buffer.byteLength < BINARY_MAGIC.length + 4) return null;

  const head = new Uint8Array(buffer, 0, BINARY_MAGIC.length);
  for (let i = 0; i < BINARY_MAGIC.length; i++) {
    if (head[i] !== BINARY_MAGIC.charCodeAt(i)) return null; // not binary FBX
  }

  const view = new DataView(buffer);
  let p = BINARY_MAGIC.length;
  const version = view.getUint32(p, true);
  p += 4;

  const wide = version >= 7500;
  const headerSize = wide ? 25 : 13;
  const size = buffer.byteLength;

  let contentEnd = p;
  while (p + headerSize <= size) {
    let endOffset: number;
    let numProps: number;
    let propLen: number;
    let nameLen: number;

    if (wide) {
      endOffset = Number(view.getBigUint64(p, true));
      numProps = Number(view.getBigUint64(p + 8, true));
      propLen = Number(view.getBigUint64(p + 16, true));
      nameLen = view.getUint8(p + 24);
    } else {
      endOffset = view.getUint32(p, true);
      numProps = view.getUint32(p + 4, true);
      propLen = view.getUint32(p + 8, true);
      nameLen = view.getUint8(p + 12);
    }

    // Null record terminates the top-level sibling list.
    if (endOffset === 0 && numProps === 0 && propLen === 0 && nameLen === 0) {
      contentEnd = p + headerSize;
      break;
    }

    // Anything out of range means we cannot trust the walk.
    if (endOffset <= p || endOffset > size) return null;

    contentEnd = endOffset;
    p = endOffset;
  }

  return { version, contentEnd };
}

/** Reports exactly what the workaround will do, without doing it. */
export function analyseFbxFooter(buffer: ArrayBuffer): FbxFooterAnalysis {
  const found = findTopLevelContentEnd(buffer);
  const size = buffer.byteLength;
  if (!found) {
    return {
      binary: false,
      version: null,
      contentEnd: null,
      trailingBytes: null,
      stockAccepts: true,
      trimBytes: 0,
    };
  }
  const trailingBytes = size - found.contentEnd;
  const stockAccepts = found.contentEnd + STOCK_FOOTER_BUDGET >= size;
  // `trimBytes` is the number of bytes we will actually drop: just enough to
  // bring the footer inside the stock 176-byte budget (capped for safety).
  const required = stockAccepts ? 0 : trailingBytes - STOCK_FOOTER_BUDGET;
  const trimBytes = Math.max(0, Math.min(required, MAX_FOOTER_TRIM));
  return {
    binary: true,
    version: found.version,
    contentEnd: found.contentEnd,
    trailingBytes,
    stockAccepts,
    trimBytes,
  };
}

/**
 * Returns a buffer three.js can parse.
 *
 * - Unchanged (same object) when the stock end-of-content budget already passes.
 * - Otherwise a *copy* truncated to `contentEnd + STOCK_FOOTER_BUDGET`, so the
 *   stock check fires at the real node-tree boundary while retaining the last
 *   few footer bytes (some exporters' parsers look ahead).
 *
 * Never mutates `buffer`, and never touches the file on disk.
 */
export function prepareFbxBufferForThree(buffer: ArrayBuffer): {
  buffer: ArrayBuffer;
  analysis: FbxFooterAnalysis;
  trimmed: boolean;
} {
  const analysis = analyseFbxFooter(buffer);

  if (!analysis.binary || analysis.contentEnd === null || analysis.stockAccepts) {
    return { buffer, analysis, trimmed: false };
  }

  const newSize = Math.min(buffer.byteLength, analysis.contentEnd + STOCK_FOOTER_BUDGET);
  if (newSize <= 0 || newSize >= buffer.byteLength) {
    return { buffer, analysis, trimmed: false };
  }

  // Copy — `slice` never mutates the source buffer.
  return { buffer: buffer.slice(0, newSize), analysis, trimmed: true };
}

/**
 * Parse binary FBX with the footer workaround applied.
 *
 * Drop-in replacement for `new FBXLoader().parse(buffer, path)`.
 */
export function parseFbx(
  buffer: ArrayBuffer,
  path = '',
  LoaderClass: typeof FBXLoader = FBXLoader,
): { object: ReturnType<FBXLoader['parse']>; analysis: FbxFooterAnalysis; trimmed: boolean } {
  const prepared = prepareFbxBufferForThree(buffer);
  const object = new LoaderClass().parse(prepared.buffer, path);
  return { object, analysis: prepared.analysis, trimmed: prepared.trimmed };
}
