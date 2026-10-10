export const MAX_PAYLOAD = 2 * 1024 * 1024;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The page imports MAX_PAYLOAD. A static node:crypto import would stop that module from loading.
function nodeCrypto() {
  return process.getBuiltinModule("node:crypto");
}

export function acceptKey(key) {
  return nodeCrypto().createHash("sha1").update(String(key) + GUID).digest("base64");
}

export function encodeFrame(opcode, payload, options = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = options.mask === true;
  const fin = options.fin !== false;
  const len = data.length;
  let headerLen = len < 126 ? 2 : len <= 0xffff ? 4 : 10;
  if (mask) headerLen += 4;
  const header = Buffer.alloc(headerLen);
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let offset = 2;
  if (len < 126) {
    header[1] = len;
  } else if (len <= 0xffff) {
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = options.maskKey ?? nodeCrypto().randomBytes(4);
  key.copy(header, offset);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, masked]);
}

export function encodeText(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return encodeFrame(0x1, Buffer.from(json));
}

// Client frames must be masked. Fragments share one cap with a single frame.
// A binary frame is image bytes. Text stays JSON, so a later edit does not resend the picture.
export function createParser({ requireMask, onText, onBinary, onPing, onClose, onError }) {
  let buf = Buffer.alloc(0);
  let fragments = null;
  let fragOpcode = 0;
  let fragLen = 0;
  let failed = false;

  function fail(reason) {
    if (failed) return;
    failed = true;
    onError(reason);
  }

  function handle(fin, opcode, payload) {
    const control = opcode >= 0x8;
    if (control) {
      if (!fin || payload.length > 125) return fail("protocol");
      if (opcode === 0x8) onClose(payload);
      else if (opcode === 0x9) onPing(payload);
      else if (opcode === 0xa) return;
      else fail("protocol");
      return;
    }
    if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) return fail("protocol");
    if (opcode === 0x1 || opcode === 0x2) {
      if (fragments) return fail("protocol");
      if (fin) {
        if (opcode === 0x2) {
          if (typeof onBinary !== "function") return fail("binary");
          onBinary(payload);
          return;
        }
        onText(payload);
        return;
      }
      fragments = [payload];
      fragOpcode = opcode;
      fragLen = payload.length;
      return;
    }
    if (!fragments) return fail("protocol");
    fragLen += payload.length;
    if (fragLen > MAX_PAYLOAD) return fail("size");
    fragments.push(payload);
    if (!fin) return;
    const full = Buffer.concat(fragments);
    const kind = fragOpcode;
    fragments = null;
    fragOpcode = 0;
    fragLen = 0;
    if (kind === 0x2) {
      if (typeof onBinary !== "function") return fail("binary");
      onBinary(full);
      return;
    }
    onText(full);
  }

  function parse() {
    while (!failed) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      if ((b0 & 0x70) !== 0) return fail("protocol");
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (masked !== requireMask) return fail(requireMask ? "unmasked" : "masked");
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return fail("size");
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_PAYLOAD) return fail("size");
      const maskLen = masked ? 4 : 0;
      const total = offset + maskLen + len;
      if (buf.length < total) return;
      let payload;
      if (masked) {
        const key = buf.subarray(offset, offset + 4);
        payload = Buffer.alloc(len);
        const raw = buf.subarray(offset + 4, total);
        for (let i = 0; i < len; i += 1) payload[i] = raw[i] ^ key[i & 3];
      } else {
        payload = Buffer.from(buf.subarray(offset, total));
      }
      buf = buf.subarray(total);
      if (buf.length === 0) buf = Buffer.alloc(0);
      else if (buf.byteOffset > 65536) buf = Buffer.from(buf);
      handle(fin, opcode, payload);
    }
  }

  return {
    push(chunk) {
      if (failed || !chunk || chunk.length === 0) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      parse();
    },
  };
}
