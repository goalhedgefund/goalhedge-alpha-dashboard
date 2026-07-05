/**
 * TypeScript port of D:\CODEX\MULTISCRIPT DASHBOARD\multiscript-standalone\
 * server\adapters\dhan\dhan.packet.decoder.js
 *
 * Handles the Dhan v2 binary WebSocket protocol. Messages may contain
 * multiple back-to-back packets (multi-packet frames). Each packet has an
 * 8-byte header:
 *
 *   Byte 0    : packet code (UInt8)
 *   Bytes 1-2 : total packet length (UInt16LE, 0 = rest of buffer)
 *   Byte 3    : exchange segment code (UInt8)
 *   Bytes 4-7 : securityId (UInt32LE)
 *
 * Dhan v2 segment codes (Annexure):
 *   0 = IDX_I, 1 = NSE_EQ, 2 = NSE_FNO, 3 = NSE_CURRENCY,
 *   4 = BSE_EQ, 5 = MCX_COMM, 7 = BSE_CURRENCY, 8 = BSE_FNO
 */

export type DhanExchangeSegment =
  | 'IDX_I'
  | 'NSE_EQ'
  | 'NSE_FNO'
  | 'BSE_EQ'
  | 'BSE_FNO'
  | 'MCX_COMM'
  | 'NSE_CURR'
  | 'BSE_CURR'
  | 'NSE_CURRENCY'
  | 'BSE_CURRENCY'
  | `SEG_${number}`;

const SEGMENT_MAP: Record<number, DhanExchangeSegment> = {
  0: 'IDX_I',
  1: 'NSE_EQ',
  2: 'NSE_FNO',
  3: 'NSE_CURRENCY',
  4: 'BSE_EQ',
  5: 'MCX_COMM',
  7: 'BSE_CURRENCY',
  8: 'BSE_FNO',
};

function getExchangeSegment(code: number): DhanExchangeSegment {
  return SEGMENT_MAP[code] ?? (`SEG_${code}` as `SEG_${number}`);
}

interface PacketHeader {
  code: number;
  length: number;
  exchangeSegment: DhanExchangeSegment;
  securityId: string;
}

function toBuffer(data: Buffer | ArrayBuffer | ArrayBufferView | string): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.alloc(0);
}

function readHeader(buf: Buffer): PacketHeader {
  return {
    code: buf.readUInt8(0),
    length: buf.readUInt16LE(1),
    exchangeSegment: getExchangeSegment(buf.readUInt8(3)),
    securityId: String(buf.readUInt32LE(4)),
  };
}

export interface DhanDepthLevel {
  bidQty: number;
  askQty: number;
  bidOrders: number;
  askOrders: number;
  bidPrice: number;
  askPrice: number;
}

export interface DhanPacketBase extends PacketHeader {
  rawLength: number;
}

export interface DhanIndexPacket extends DhanPacketBase {
  code: 1;
  ltp: number;
  ltt: number;
}

export interface DhanLtpPacket extends DhanPacketBase {
  code: 2;
  ltp: number;
  ltt: number;
}

export interface DhanQuotePacket extends DhanPacketBase {
  code: 4;
  ltp: number;
  qty: number;
  ltt: number;
  atp: number;
  volume: number;
  sellQty: number;
  buyQty: number;
  dayOpen: number;
  dayClose: number;
  dayHigh: number;
  dayLow: number;
}

export interface DhanOiPacket extends DhanPacketBase {
  code: 5;
  oi: number;
}

export interface DhanPrevClosePacket extends DhanPacketBase {
  code: 6;
  prevClose: number;
  prevOi: number;
}

export interface DhanFullPacket extends DhanPacketBase {
  code: 8;
  ltp: number;
  qty: number;
  ltt: number;
  atp: number;
  volume: number;
  sellQty: number;
  buyQty: number;
  oi: number;
  highOi: number;
  lowOi: number;
  dayOpen: number;
  dayClose: number;
  dayHigh: number;
  dayLow: number;
  depth: DhanDepthLevel[];
}

export interface DhanDisconnectPacket extends DhanPacketBase {
  code: 50;
  disconnectReason: number;
}

export interface DhanUnknownPacket extends DhanPacketBase {
  payload: Buffer;
}

export type DhanPacket =
  | DhanIndexPacket
  | DhanLtpPacket
  | DhanQuotePacket
  | DhanOiPacket
  | DhanPrevClosePacket
  | DhanFullPacket
  | DhanDisconnectPacket
  | DhanUnknownPacket;

function decodePacket(buf: Buffer): DhanPacket {
  const base: DhanPacketBase = { ...readHeader(buf), rawLength: buf.length };

  const unknown = (): DhanUnknownPacket => ({ ...base, payload: buf.subarray(8) });

  switch (base.code) {
    case 1:
      if (buf.length < 12) return unknown();
      return {
        ...base,
        code: 1,
        ltp: buf.readFloatLE(8),
        ltt: buf.length >= 16 ? buf.readInt32LE(12) : 0,
      };
    case 2:
      if (buf.length < 16) return unknown();
      return {
        ...base,
        code: 2,
        ltp: buf.readFloatLE(8),
        ltt: buf.readInt32LE(12),
      };
    case 4:
      if (buf.length < 50) return unknown();
      return {
        ...base,
        code: 4,
        ltp: buf.readFloatLE(8),
        qty: buf.readInt16LE(12),
        ltt: buf.readInt32LE(14),
        atp: buf.readFloatLE(18),
        volume: buf.readInt32LE(22),
        sellQty: buf.readInt32LE(26),
        buyQty: buf.readInt32LE(30),
        dayOpen: buf.readFloatLE(34),
        dayClose: buf.readFloatLE(38),
        dayHigh: buf.readFloatLE(42),
        dayLow: buf.readFloatLE(46),
      };
    case 5:
      if (buf.length < 12) return unknown();
      return { ...base, code: 5, oi: buf.readInt32LE(8) };
    case 6:
      if (buf.length < 16) return unknown();
      return {
        ...base,
        code: 6,
        prevClose: buf.readFloatLE(8),
        prevOi: buf.readInt32LE(12),
      };
    case 8: {
      if (buf.length < 62) return unknown();
      const depth: DhanDepthLevel[] = [];
      for (let i = 62; i + 20 <= Math.min(buf.length, 162); i += 20) {
        depth.push({
          bidQty: buf.readInt32LE(i),
          askQty: buf.readInt32LE(i + 4),
          bidOrders: buf.readInt16LE(i + 8),
          askOrders: buf.readInt16LE(i + 10),
          bidPrice: buf.readFloatLE(i + 12),
          askPrice: buf.readFloatLE(i + 16),
        });
      }
      return {
        ...base,
        code: 8,
        ltp: buf.readFloatLE(8),
        qty: buf.readInt16LE(12),
        ltt: buf.readInt32LE(14),
        atp: buf.readFloatLE(18),
        volume: buf.readInt32LE(22),
        sellQty: buf.readInt32LE(26),
        buyQty: buf.readInt32LE(30),
        oi: buf.readInt32LE(34),
        highOi: buf.readInt32LE(38),
        lowOi: buf.readInt32LE(42),
        dayOpen: buf.readFloatLE(46),
        dayClose: buf.readFloatLE(50),
        dayHigh: buf.readFloatLE(54),
        dayLow: buf.readFloatLE(58),
        depth,
      };
    }
    case 50:
      return {
        ...base,
        code: 50,
        disconnectReason: buf.length >= 12 ? buf.readInt32LE(8) : 0,
      };
    default:
      return { ...base, payload: buf.subarray(8) };
  }
}

/**
 * Decode a raw Dhan WebSocket frame (may contain multiple back-to-back
 * packets, or be a JSON text fallback). Returns an array of decoded packets.
 */
export function decodeDhanBuffer(
  data: Buffer | ArrayBuffer | ArrayBufferView | string,
): DhanPacket[] {
  const buf = toBuffer(data);
  if (buf.length === 0) return [];

  const firstNonWhitespace = buf.toString('utf8', 0, Math.min(buf.length, 16)).trimStart()[0];
  if (firstNonWhitespace === '{' || firstNonWhitespace === '[') {
    try {
      const parsed: unknown = JSON.parse(buf.toString('utf8'));
      return Array.isArray(parsed) ? (parsed as DhanPacket[]) : [parsed as DhanPacket];
    } catch {
      return [];
    }
  }

  const packets: DhanPacket[] = [];
  let offset = 0;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt16LE(offset + 1) || buf.length - offset;
    const packetLength = Math.max(8, Math.min(length, buf.length - offset));
    const slice = buf.subarray(offset, offset + packetLength);
    if (slice.length < 8) break;
    packets.push(decodePacket(slice));
    offset += packetLength;
    if (packetLength <= 0) break;
  }

  if (packets.length === 0) {
    try {
      const parsed: unknown = JSON.parse(buf.toString('utf8'));
      return Array.isArray(parsed) ? (parsed as DhanPacket[]) : [parsed as DhanPacket];
    } catch {
      return [
        {
          code: 0,
          length: buf.length,
          exchangeSegment: 'NSE_EQ',
          securityId: '',
          rawLength: buf.length,
          payload: buf,
        } as DhanUnknownPacket,
      ];
    }
  }

  return packets;
}
