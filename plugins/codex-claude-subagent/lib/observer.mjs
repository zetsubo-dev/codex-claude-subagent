import fs from "node:fs";
import path from "node:path";

export function readObserverRecords(directory, generation, afterSeq) {
  const records = [];
  records.pending = false;
  records.skipped_sequences = [];
  let expected = afterSeq + 1;
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^event-\d{8}\.json$/.test(name))
    .sort()
    .slice(0, 4096);
  for (const [index, file] of files.entries()) {
    if (Number(file.slice(6, 14)) <= afterSeq) continue;
    const target = path.join(directory, file);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) continue;
    try {
      const event = JSON.parse(fs.readFileSync(target, "utf8"));
      if (
        event.schema !== 1 ||
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
