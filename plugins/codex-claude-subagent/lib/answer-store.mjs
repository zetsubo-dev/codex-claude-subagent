import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeUtf8Slice } from "./utf8.mjs";

const STORE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REF = /^ans1\.([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\.([a-f0-9]{32})\.([0-9]{8})$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class AnswerReadError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "AnswerReadError";
    this.code = code;
  }
}

function readError(error) {
  if (error instanceof AnswerReadError) return error;
  return new AnswerReadError(error?.code === "ENOENT" ? "not_found" : "io_error", error.message, { cause: error });
}

export function parseAnswerRef(ref) {
  const match = typeof ref === "string" ? REF.exec(ref) : null;
  if (!match || Number(match[3]) < 1) throw new AnswerReadError("invalid_ref", "Invalid answer reference.");
  return { storeId: match[1], name: `${match[2]}.${match[3]}.answer` };
}

export function createAnswerStore({ root, fileMode = 0o600, dirMode = 0o700 }) {
  function directory(storeId, create = false) {
    if (!STORE_ID.test(storeId || "")) throw new AnswerReadError("invalid_ref", "Invalid answer store id.");
    for (const target of [root, path.join(root, storeId)]) {
      if (create) {
        try {
          fs.mkdirSync(target, { mode: dirMode });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      const stat = fs.lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new AnswerReadError("corrupt", "Unsafe answer directory.");
    }
    return path.join(root, storeId);
  }

  function open(ref) {
    const { storeId, name } = parseAnswerRef(ref);
    const target = path.join(directory(storeId), name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AnswerReadError("corrupt", "Unsafe answer file.");
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const prefix = Buffer.alloc(Math.min(16384, stat.size));
      const bytesRead = fs.readSync(fd, prefix, 0, prefix.length, 0);
      const newline = prefix.subarray(0, bytesRead).indexOf(10);
      if (newline < 0) throw new AnswerReadError("corrupt", "Missing answer header.");
      let header;
      try {
        header = JSON.parse(prefix.subarray(0, newline).toString("utf8"));
      } catch (error) {
        throw new AnswerReadError("corrupt", "Invalid answer header.", { cause: error });
      }
      const headerBytes = newline + 1;
      if (
        header.ref !== ref ||
        !Number.isSafeInteger(header.bytes) ||
        header.bytes < 1 ||
        !Number.isSafeInteger(header.utf16) ||
        header.utf16 < 1 ||
        !SHA256.test(header.sha256 || "") ||
        typeof header.lossless !== "boolean" ||
        !header.origin ||
        typeof header.origin !== "object" ||
        fs.fstatSync(fd).size !== headerBytes + header.bytes
      ) {
        throw new AnswerReadError("corrupt", "Answer header or file size is inconsistent.");
      }
      return { fd, header, headerBytes };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  function ingest({ storeId, generation, seq, body, expect, origin }) {
    const gen = String(generation).replaceAll("-", "");
    const ref = `ans1.${storeId}.${gen}.${String(seq).padStart(8, "0")}`;
    const { name } = parseAnswerRef(ref);
    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      return { status: "not_captured", reason: "integrity_mismatch", detail: "Observer parts are not valid UTF-8." };
    }
    if (
      expect?.bytes !== body.length ||
      expect?.utf16 !== text.length ||
      typeof expect?.lossless !== "boolean" ||
      (expect.sha256 !== null && expect.sha256 !== sha256)
    ) {
      return {
        status: "not_captured",
        reason: "integrity_mismatch",
        detail: "Observer answer lengths or digest do not match its parts.",
      };
    }
    const descriptor = {
      status: "stored",
      ref,
      bytes: body.length,
      utf16: text.length,
      sha256,
      lossless: expect.lossless,
    };
    const header = { ref, bytes: body.length, utf16: text.length, sha256, lossless: expect.lossless, origin };
    const target = path.join(directory(storeId, true), name);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      const existing = open(ref);
      try {
        const savedBody = Buffer.alloc(existing.header.bytes);
        const count = fs.readSync(existing.fd, savedBody, 0, savedBody.length, existing.headerBytes);
        if (
          existing.header.sha256 !== sha256 ||
          count !== savedBody.length ||
          crypto.createHash("sha256").update(savedBody).digest("hex") !== sha256
        ) {
          throw new Error("An immutable answer already exists with different content.");
        }
        return descriptor;
      } finally {
        fs.closeSync(existing.fd);
      }
    }
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", fileMode);
      fs.writeFileSync(fd, Buffer.from(JSON.stringify(header) + "\n"));
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, target);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
    return descriptor;
  }

  function read(ref, { offset = 0, maxBytes = 200000 } = {}, scopeOf) {
    const { storeId } = parseAnswerRef(ref);
    if (scopeOf && !scopeOf(storeId))
      throw new AnswerReadError("session_not_registered", "The answer's session is not registered.");
    let opened;
    try {
      opened = open(ref);
      const { fd, header, headerBytes } = opened;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > header.bytes) {
        throw new AnswerReadError("offset_out_of_range", "Answer offset is outside its body.");
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
        throw new AnswerReadError("offset_out_of_range", "Answer page size must be at least 4 bytes.");
      }
      const buffer = Buffer.alloc(Math.min(maxBytes, header.bytes - offset));
      const count = fs.readSync(fd, buffer, 0, buffer.length, headerBytes + offset);
      if (count !== buffer.length || fs.fstatSync(fd).size !== headerBytes + header.bytes) {
        throw new AnswerReadError("corrupt", "Answer body is shorter than its header declares.");
      }
      if (buffer.length && (buffer[0] & 0xc0) === 0x80) {
        throw new AnswerReadError("offset_not_char_boundary", "Answer offset splits a UTF-8 character.");
      }
      const { end } = safeUtf8Slice(buffer, maxBytes);
      if (buffer.length && !end) throw new AnswerReadError("corrupt", "Invalid UTF-8 answer body.");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, end));
      } catch (error) {
        throw new AnswerReadError("corrupt", "Invalid UTF-8 answer body.", { cause: error });
      }
      const next = offset + end;
      if (next < header.bytes && offset + buffer.length === header.bytes) {
        throw new AnswerReadError("corrupt", "Answer ends inside a UTF-8 character.");
      }
      return {
        answer_ref: ref,
        text,
        start_offset: offset,
        next_offset: next,
        total_bytes: header.bytes,
        sha256: header.sha256,
        lossless: header.lossless,
        eof: next === header.bytes,
        origin: header.origin,
      };
    } catch (error) {
      throw readError(error);
    } finally {
      if (opened) fs.closeSync(opened.fd);
    }
  }

  function preview(ref, maxUtf16) {
    const page = read(ref, { offset: 0, maxBytes: Math.max(4, maxUtf16 * 4) });
    let end = Math.min(page.text.length, maxUtf16);
    if (
      end < page.text.length &&
      page.text.charCodeAt(end - 1) >= 0xd800 &&
      page.text.charCodeAt(end - 1) <= 0xdbff &&
      page.text.charCodeAt(end) >= 0xdc00 &&
      page.text.charCodeAt(end) <= 0xdfff
    )
      end -= 1;
    const text = page.text.slice(0, end);
    return { text, truncated: Buffer.byteLength(text) < page.total_bytes };
  }

  function sizeOf(storeId) {
    let dir;
    try {
      dir = directory(storeId);
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
    return fs.readdirSync(dir).reduce((total, name) => {
      const stat = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false });
      return total + (stat?.isFile() && !stat.isSymbolicLink() ? stat.size : 0);
    }, 0);
  }

  function remove(storeId) {
    let dir;
    try {
      dir = directory(storeId);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    fs.rmSync(dir, { recursive: true });
  }

  return { ingest, read, preview, sizeOf, remove };
}
