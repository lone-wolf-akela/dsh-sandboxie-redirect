/**
 * Frame codec for the launcher <-> boxed-relay TCP channel.
 *
 * The relay runs *inside* the Sandboxie box, so it cannot be handed the
 * launcher's stdio handles (SbieSvc creates it, not us — see M0 findings).
 * A length-prefixed frame stream over a loopback socket is the transport that
 * survives the box boundary (verified: named pipes do not, TCP loopback does).
 *
 * frame := u8 type | u32be length | length bytes
 */

export const Frame = {
  HELLO: 1,
  SPEC: 2,
  STDIN: 3,
  STDIN_EOF: 4,
  STDOUT: 16,
  STDERR: 17,
  EXIT: 18,
  FAIL: 19,
  READY: 20
};

export const MAX_FRAME = 8 * 1024 * 1024;

/** Encode one frame. `payload` may be a string (utf8) or a Buffer. */
export function encodeFrame(type, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Encode one frame carrying JSON. */
export function encodeJsonFrame(type, value) {
  return encodeFrame(type, JSON.stringify(value));
}

/**
 * Incremental decoder: feed it socket chunks, receive complete frames.
 * @param {(type: number, body: Buffer) => void} onFrame
 * @param {(error: Error) => void} [onError]
 */
export function createFrameDecoder(onFrame, onError) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 5) return;
      const type = pending.readUInt8(0);
      const length = pending.readUInt32BE(1);
      if (length > MAX_FRAME) {
        onError?.(new Error(`frame too large: ${length}`));
        return;
      }
      if (pending.length < 5 + length) return;
      const body = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      onFrame(type, body);
    }
  };
}
