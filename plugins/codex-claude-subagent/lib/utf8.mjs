export function utf8SequenceLength(byte) {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

export function safeUtf8Slice(buffer, maxBytes) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  if (start >= buffer.length) return { start, end: start };
  const available = buffer.length - start;
  let end = start + Math.min(maxBytes, available);
  while (end > start) {
    let lead = end - 1;
    while (lead > start && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
    const sequenceLength = utf8SequenceLength(buffer[lead]);
    if (lead + sequenceLength <= end) break;
    end = lead;
  }
  if (end === start) {
    const firstLength = utf8SequenceLength(buffer[start]);
    if (firstLength <= maxBytes && start + firstLength <= buffer.length) end = start + firstLength;
  }
  return { start, end };
}
