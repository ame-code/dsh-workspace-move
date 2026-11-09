/**
 * Physical rewriting of one session artifact when its working directory changes.
 *
 * Only the header frame is re-encoded — it carries the single `cwd` field the
 * backend uses to locate and validate the log. Every other byte, including every
 * event record inside the payload frame, is preserved verbatim, so recorded
 * history keeps saying what actually ran and the artifact stays a valid log for
 * the backend's own scanner.
 * @module @reed-io/dsh-workspace-move
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants, zstdCompress, zstdDecompressSync } from "node:zlib";
import { promisify } from "node:util";

const zstdCompressAsync = promisify(zstdCompress);

/**
 * Decompress one complete zstd frame. zlib's async decode can answer an empty
 * buffer for a frame smaller than its output chunk, so the frame is decoded in
 * place; frames here are single header lines, never large.
 * @param frame - one complete zstd frame.
 * @returns the decompressed bytes.
 */
function zstdDecompressFrame(frame, options = undefined) {
  return Promise.resolve(zstdDecompressSync(frame, options));
}
const ZSTD_MAGIC = 4247762216;
const CHECKSUM_OPTS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/**
 * Detect zstd framing from the bytes themselves — staging files may not carry the
 * `.zstd` suffix while a rewrite is in flight.
 * @param buffer - artifact bytes.
 * @returns whether the artifact starts with a zstd frame.
 */
export function isZstdFramed(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC;
}

/**
 * Measure every complete Zstandard frame in a buffer without decoding them.
 * @param buffer - artifact bytes.
 * @returns frame boundaries plus the offset of a torn trailing frame, if any.
 */
export function scanFrames(buffer) {
  const frames = [];
  let start = 0;
  while (start < buffer.length) {
    let offset = start;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      if (frames.length === 0) throw new Error("session artifact is not zstd framed");
      return { frames, tornStart: start };
    }
    offset += 4;
    if (buffer.length - offset < 1) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error("zstd frame carries reserved bits");
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (offset > buffer.length) return { frames, tornStart: start };
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("zstd frame holds a reserved block type");
      offset += blockType === 1 ? 1 : blockSize;
      if (offset > buffer.length) return { frames, tornStart: start };
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    start = offset;
  }
  return { frames };
}

/**
 * Split an artifact into its header line text and the untouched byte tail.
 * @param buffer - artifact bytes.
 * @param compressed - whether the artifact is zstd framed.
 * @returns the header text (without its newline) and the tail to preserve.
 */
async function splitHeader(buffer, compressed) {
  if (!compressed) {
    const newline = buffer.indexOf(10);
    const text = (newline < 0 ? buffer : buffer.subarray(0, newline)).toString("utf8");
    return { text, tail: newline < 0 ? Buffer.alloc(0) : buffer.subarray(newline + 1) };
  }
  const { frames } = scanFrames(buffer);
  if (frames.length === 0) throw new Error("session artifact holds no complete zstd frame");
  const first = frames[0];
  const text = (await zstdDecompressFrame(buffer.subarray(first.start, first.end))).toString("utf8");
  return { text: text.replace(/\n$/u, ""), tail: buffer.subarray(first.end) };
}

/**
 * Read the header of an artifact this module just wrote.
 * @param path - artifact path.
 * @returns the parsed header.
 */
async function readTranscodedHeader(path) {
  const buffer = await readFile(path);
  const { frames } = scanFrames(buffer);
  const text = (await zstdDecompressFrame(buffer.subarray(frames[0].start, frames[0].end))).toString("utf8");
  return JSON.parse(text);
}

/**
 * Read one artifact's header line as an object.
 * @param path - artifact path.
 * @returns the parsed header.
 */
export async function readArtifactHeader(path) {
  const buffer = await readFile(path);
  const { text } = await splitHeader(buffer, isZstdFramed(buffer));
  return JSON.parse(text);
}

/**
 * Re-encode one header line in the artifact's own framing.
 * @param header - header object to encode.
 * @param compressed - whether the artifact is zstd framed.
 * @returns encoded header frame including its newline.
 */
async function encodeHeader(header, compressed) {
  const line = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  return compressed ? zstdCompressAsync(line, CHECKSUM_OPTS) : line;
}

/**
 * Rewrite one artifact's header cwd in place, keeping its payload byte-identical.
 * @param path - artifact path.
 * @param cwd - replacement working directory.
 * @param expectedId - session id the artifact must carry.
 * @returns whether the artifact changed.
 */
export async function rewriteArtifactCwd(path, cwd, expectedId) {
  const buffer = await readFile(path);
  const compressed = isZstdFramed(buffer);
  const { text, tail } = await splitHeader(buffer, compressed);
  const header = JSON.parse(text);
  if (header.id !== expectedId) throw new Error(`session artifact '${path}' holds '${String(header.id)}', expected '${expectedId}'`);
  if (header.cwd === cwd) return false;
  const stage = join(dirname(path), `.stage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const bytes = Buffer.concat([await encodeHeader({ ...header, cwd }, compressed), tail]);
  try {
    await writeFile(stage, bytes);
    await rename(stage, path);
  } catch (error) {
    await rm(stage, { force: true }).catch(() => {});
    throw error;
  }
  const written = await readArtifactHeader(path);
  if (written.id !== expectedId || written.cwd !== cwd) throw new Error(`session artifact '${path}' did not accept cwd '${cwd}'`);
  return true;
}

/**
 * Write one session's artifact at a new path with a rewritten header, then read
 * it back. Fails when the target already exists.
 * @param source - original artifact path.
 * @param target - new artifact path (its parent must exist).
 * @param cwd - replacement working directory.
 * @param expectedId - session id the artifact must carry.
 * @returns nothing; throws when the copy cannot be verified.
 */
export async function copyArtifactWithCwd(source, target, cwd, expectedId) {
  const buffer = await readFile(source);
  const compressed = isZstdFramed(buffer);
  const { text, tail } = await splitHeader(buffer, compressed);
  const header = JSON.parse(text);
  if (header.id !== expectedId) throw new Error(`session artifact '${source}' holds '${String(header.id)}', expected '${expectedId}'`);
  await writeFile(target, Buffer.concat([await encodeHeader({ ...header, cwd }, compressed), tail]), { flag: "wx" });
  const reread = await readFile(target);
  const written = JSON.parse((await splitHeader(reread, isZstdFramed(reread))).text);
  if (written.id !== expectedId || written.cwd !== cwd) throw new Error(`copied session artifact '${target}' did not accept cwd '${cwd}'`);
}

/**
 * Decode and re-encode one artifact into a new file, rewriting its header cwd and
 * re-compressing every record — the fallback for an artifact whose payload could
 * not be copied verbatim after a provable header rewrite.
 * @param source - original artifact path.
 * @param target - new artifact path (its parent must exist, file must not exist).
 * @param cwd - replacement working directory.
 * @param expectedId - session id the artifact must carry.
 * @returns the number of event records re-encoded.
 */
export async function transcodeArtifactWithCwd(source, target, cwd, expectedId) {
  const buffer = await readFile(source);
  const compressed = isZstdFramed(buffer);
  const { text } = await splitHeader(buffer, compressed);
  const header = JSON.parse(text);
  if (header.id !== expectedId) throw new Error(`session artifact '${source}' holds '${String(header.id)}', expected '${expectedId}'`);
  let plain;
  if (compressed) {
    const { frames, tornStart } = scanFrames(buffer);
    const parts = [];
    for (const frame of frames) parts.push(await zstdDecompressFrame(buffer.subarray(frame.start, frame.end)));
    plain = Buffer.concat(parts).toString("utf8");
    if (tornStart !== undefined) plain += (await zstdDecompressFrame(buffer.subarray(tornStart), { finishFlush: constants.ZSTD_e_flush })).toString("utf8");
  } else {
    plain = buffer.toString("utf8");
  }
  const newline = plain.indexOf("\n");
  const body = newline < 0 ? "" : plain.slice(newline + 1).replace(/\n$/u, "");
  const records = body === "" ? [] : body.split("\n");
  for (const record of records) JSON.parse(record);
  const bytes = [await encodeHeader({ ...header, cwd }, compressed)];
  if (records.length > 0) {
    const payload = Buffer.from(`${records.join("\n")}\n`, "utf8");
    bytes.push(compressed ? await zstdCompressAsync(payload, CHECKSUM_OPTS) : payload);
  }
  const staged = `${target}.stage-${process.pid}-${Date.now()}`;
  await mkdir(dirname(staged), { recursive: true });
  await writeFile(staged, Buffer.concat(bytes), { flag: "wx" });
  await rm(target, { force: true });
  await rename(staged, target);
  const written = await readTranscodedHeader(target);
  if (written.id !== expectedId || written.cwd !== cwd) throw new Error(`transcoded session artifact '${target}' did not accept cwd '${cwd}'`);
  return records.length;
}
