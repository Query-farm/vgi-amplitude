/**
 * Spool a download to disk and stream the lines of the gzip files inside a ZIP
 * archive, without holding the archive or any decompressed file in memory.
 *
 * The Export API answers with a ZIP archive of gzip-compressed JSON Lines files
 * (one or more per hour). A ZIP's directory sits at its end, so the response is
 * first written to a temporary file; entries are then read straight from that file
 * through `inflateRaw` (ZIP deflate) and `gunzip`, and split into lines lazily, so
 * memory stays bounded by one read chunk however large the export is. ZIP64
 * archives (over 4 GiB, which Amplitude's 6 GB limit allows) are supported.
 */

import { createReadStream, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflateRaw } from "node:zlib";

export class ZipError extends Error {}

/** This process's spool directory (removed on exit). */
let spoolDir: string | undefined;
function dir(): string {
  if (!spoolDir) {
    spoolDir = join(tmpdir(), `vgi-amplitude-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    const d = spoolDir;
    process.once("exit", () => {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });
  }
  return spoolDir;
}

/** Write a response body to a new temporary file; returns its path. */
export async function spool(body: ReadableStream<Uint8Array> | null, suffix: string): Promise<string> {
  const path = join(dir(), `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${suffix}`);
  if (!body) {
    await Bun.write(path, "");
    return path;
  }
  // biome-ignore lint/suspicious/noExplicitAny: web → node stream bridge typing.
  await pipeline(Readable.fromWeb(body as any), createWriteStream(path, { mode: 0o600 }));
  return path;
}

export async function removeSpool(path: string): Promise<void> {
  await rm(path, { force: true });
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_Z64_LOCATOR = 0x07064b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function u64(b: Buffer, off: number): number {
  const v = b.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("ZIP64 value out of range");
  return Number(v);
}

async function readAt(fd: Awaited<ReturnType<typeof open>>, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new ZipError("truncated ZIP archive");
  return buf;
}

/** Read a ZIP archive's central directory (handles ZIP64). */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
  const fd = await open(path, "r");
  try {
    const size = (await fd.stat()).size;
    if (size < 22) throw new ZipError("not a ZIP archive (too short)");
    const tailLen = Math.min(size, 22 + 65_535);
    const tail = await readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("not a ZIP archive (no end-of-central-directory record)");
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locPos = size - tailLen + eocd - 20;
      if (locPos < 0) throw new ZipError("ZIP64 locator missing");
      const loc = await readAt(fd, locPos, 20);
      if (loc.readUInt32LE(0) !== SIG_Z64_LOCATOR) throw new ZipError("ZIP64 locator missing");
      const z64 = await readAt(fd, u64(loc, 8), 56);
      if (z64.readUInt32LE(0) !== SIG_Z64_EOCD) throw new ZipError("bad ZIP64 end-of-central-directory record");
      count = u64(z64, 32);
      cdSize = u64(z64, 40);
      cdOffset = u64(z64, 48);
    }
    const cd = await readAt(fd, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError("bad ZIP central directory entry");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      // ZIP64 extended information: only the fields saturated above are present, in this order.
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = u64(cd, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(cd, q);
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(cd, q);
        }
        e += 4 + len;
      }
      if (flags & 0x1) throw new ZipError(`ZIP entry ${name} is encrypted`);
      if (method !== 0 && method !== 8) throw new ZipError(`ZIP entry ${name} uses unsupported method ${method}`);
      if (!name.endsWith("/")) entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fd.close();
  }
}

/** Where an entry's compressed data starts (after its local header). */
async function dataOffset(path: string, entry: ZipEntry): Promise<number> {
  const fd = await open(path, "r");
  try {
    const h = await readAt(fd, entry.localHeaderOffset, 30);
    if (h.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError(`bad ZIP local header for ${entry.name}`);
    return entry.localHeaderOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    await fd.close();
  }
}

/** A readable stream of an entry's (ZIP-decompressed, then gunzipped if `.gz`) bytes. */
export async function entryStream(path: string, entry: ZipEntry): Promise<NodeJS.ReadableStream> {
  const start = await dataOffset(path, entry);
  if (entry.compressedSize === 0) return Readable.from([]);
  let s: NodeJS.ReadableStream = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
  if (entry.method === 8) s = s.pipe(createInflateRaw());
  if (/\.gz$/i.test(entry.name)) s = s.pipe(createGunzip());
  return s;
}

/** Split a byte stream into non-empty text lines, lazily (pull-based, bounded memory). */
export async function* lines(stream: NodeJS.ReadableStream | AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    carry += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let i = carry.indexOf("\n");
    while (i >= 0) {
      const line = carry.slice(0, i).replace(/\r$/, "");
      if (line.trim() !== "") yield line;
      carry = carry.slice(i + 1);
      i = carry.indexOf("\n");
    }
  }
  carry += decoder.decode();
  if (carry.trim() !== "") yield carry.replace(/\r$/, "");
}

/** A position inside an archive: entry index and lines consumed within it. */
export interface ArchivePos {
  entry: number;
  line: number;
}

/**
 * Iterate the JSON lines of every entry of a spooled archive, in entry-name order,
 * starting at `from` (skipping what an earlier process already emitted). The
 * position after each yielded line is reported through `pos`.
 */
export async function* archiveLines(
  path: string,
  from: ArchivePos,
  pos: ArchivePos,
): AsyncGenerator<string, void, undefined> {
  const entries = (await readZipEntries(path)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = from.entry; i < entries.length; i++) {
    const entry = entries[i] as ZipEntry;
    let n = 0;
    const skip = i === from.entry ? from.line : 0;
    pos.entry = i;
    pos.line = 0;
    for await (const line of lines(await entryStream(path, entry))) {
      n++;
      if (n <= skip) continue;
      pos.line = n;
      yield line;
    }
    pos.entry = i + 1;
    pos.line = 0;
  }
}
