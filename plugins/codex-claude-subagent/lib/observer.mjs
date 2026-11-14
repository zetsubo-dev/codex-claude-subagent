import fs from "node:fs";
import path from "node:path";

export function readObserverRecords(directory, generation, afterSeq) {
  const records = [];
  records.pending = false;
  records.skipped_sequences = [];
  let expected = afterSeq + 1;
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^event-\d{8}\.json$/.test(name) && Number(name.slice(6, 14)) > afterSeq)
    .sort()
    .slice(0, 4096);
  for (const [index, file] of files.entries()) {
    const target = path.join(directory, file);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) continue;
    try {
      const event = JSON.parse(fs.readFileSync(target, "utf8"));
      if (
        event.schema !== 2 ||
        event.generation !== generation ||
        !Number.isSafeInteger(event.seq) ||
        event.seq <= afterSeq ||
        event.seq !== Number(file.slice(6, 14)) ||
        typeof event.session_id !== "string"
      )
        continue;
      if (event.seq !== expected) records.skipped_sequences.push(expected);
      records.push({ event, file: target });
      expected = event.seq + 1;
    } catch {
      // $.fs.write is not atomic; retry incomplete records on the next poll.
      // A later file proves this serialized write already ended unsuccessfully.
      if (index + 1 < files.length) records.skipped_sequences.push(Number(file.slice(6, 14)));
      else {
        records.pending = true;
        break;
      }
    }
  }
  return records;
}

function sequenceName(seq) {
  if (!Number.isInteger(seq) || seq < 1 || seq > 99999999) throw new Error("Invalid observer sequence.");
  return String(seq).padStart(8, "0");
}

export function readAnswerParts(directory, seq, count) {
  const number = sequenceName(seq);
  if (!Number.isInteger(count) || count < 1 || count > 9999) throw new Error("Invalid observer part count.");
  const dirStat = fs.lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("Unsafe observer directory.");
  const parts = [];
  for (let part = 1; part <= count; part += 1) {
    const target = path.join(directory, `answer-${number}-${String(part).padStart(4, "0")}.txt`);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 786432) throw new Error("Invalid observer answer part.");
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      parts.push(fs.readFileSync(fd));
    } finally {
      fs.closeSync(fd);
    }
  }
  return Buffer.concat(parts);
}

export function removeObserverRecord(directory, seq) {
  const number = sequenceName(seq);
  for (const name of fs.readdirSync(directory)) {
    if (
      name === `event-${number}.json` ||
      (name.startsWith(`answer-${number}-`) && /^answer-\d{8}-\d{4}\.txt$/.test(name))
    ) {
      fs.rmSync(path.join(directory, name), { force: true });
    }
  }
}

export function observerResidualBytes(directory) {
  if (!directory) return 0;
  const dirStat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) return 0;
  let bytes = 0;
  for (const name of fs.readdirSync(directory)) {
    const stat = fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false });
    if (stat?.isFile() && !stat.isSymbolicLink()) bytes += stat.size;
  }
  return bytes;
}
