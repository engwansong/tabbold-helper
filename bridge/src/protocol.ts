// Chrome native messaging framing: each message is a 4-byte little-endian
// uint32 length followed by that many bytes of UTF-8 JSON.
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

import type { Readable, Writable } from "node:stream";

export const MAX_OUTBOUND_BYTES = 1024 * 1024; // Chrome's limit for host → browser

export function encode(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_OUTBOUND_BYTES) {
    throw new Error(`Message too large for native messaging (${json.length} bytes)`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** Incrementally decodes framed messages from a byte stream. */
export class Decoder {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body));
    }
    return out;
  }
}

export function listen(
  input: Readable,
  output: Writable,
  handle: (msg: unknown, send: (m: unknown) => void) => Promise<unknown>,
  onEnd?: () => void,
): void {
  const decoder = new Decoder();
  // Each message is handled as soon as it arrives, so a slow AI call can't
  // hold up a status check or a save. (Vault writes are serialised inside the
  // handlers.) Each reply is one write of one framed buffer, so frames never
  // interleave.
  const send = (m: unknown) => output.write(encode(m));
  const pending = new Set<Promise<unknown>>();
  input.on("data", (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      const p = handle(msg, send)
        .then((reply) => send(reply))
        .catch((err) => console.error("tabbold: handler failed", err))
        .finally(() => pending.delete(p));
      pending.add(p);
    }
  });
  input.on("end", () => {
    onEnd?.();
    Promise.allSettled([...pending]).finally(() => process.exit(0));
  });
}
