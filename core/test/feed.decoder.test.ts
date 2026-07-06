/**
 * Dhan binary packet decoder tests (M3 acceptance).
 *
 * Binary packet header layout (all little-endian):
 *   [0]     code         UInt8
 *   [1-2]   length       UInt16LE  (0 = rest of buffer)
 *   [3]     segment      UInt8     (2 = NSE_FNO)
 *   [4-7]   securityId   UInt32LE
 *
 * Code 2  (LTP):    [8-11] ltp FloatLE, [12-15] ltt Int32LE
 * Code 4  (Quote):  above + [14..49] full quote fields
 * Code 8  (Full):   above + [34..61] OI fields + [62+] depth levels (20B each)
 * Code 50 (Disc):   [8-11] reason Int32LE
 */

import { describe, expect, it } from 'vitest';
import {
  decodeDhanBuffer,
  type DhanDisconnectPacket,
  type DhanFullPacket,
  type DhanIndexPacket,
  type DhanLtpPacket,
  type DhanOiPacket,
  type DhanQuotePacket,
} from '../src/feed/dhan/packet-decoder.js';
import { makeInstrumentId } from '../src/domain/ids.js';
import { dhanPacketToTick } from '../src/feed/dhan/feed.js';

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

function makeHeader(buf: Buffer, code: number, length: number, segment: number, secId: number): void {
  buf.writeUInt8(code, 0);
  buf.writeUInt16LE(length, 1);
  buf.writeUInt8(segment, 3);
  buf.writeUInt32LE(secId, 4);
}

describe('code 1 - Index packet', () => {
  it('decodes index ltp and normalizes it to a spot tick', () => {
    const buf = Buffer.alloc(16, 0);
    makeHeader(buf, 1, 16, 0, 13);
    buf.writeFloatLE(24501.25, 8);
    buf.writeInt32LE(1782000000, 12);

    const [p] = decodeDhanBuffer(buf);
    expect(p?.code).toBe(1);
    expect(p?.exchangeSegment).toBe('IDX_I');
    if (p?.code === 1) {
      const index = p as DhanIndexPacket;
      expect(index.securityId).toBe('13');
      expect(index.ltp).toBeCloseTo(24501.25, 2);
    }

    const spotId = makeInstrumentId('NSE', 'NIFTY_SPOT');
    const tick = dhanPacketToTick(p!, 1_782_001_000_000, new Map([['13', spotId]]));
    expect(tick).not.toBeNull();
    expect(tick!.instrumentId).toBe(spotId);
    expect(tick!.ltpPaise).toBe(2_450_125);
    expect(tick!.ts).toBe(1_782_000_000_000);
    expect(tick!.qty).toBe(0);
  });

  it('normalizes Dhan ltt values that arrive one IST offset ahead of recv time', () => {
    const buf = Buffer.alloc(16, 0);
    makeHeader(buf, 1, 16, 0, 13);
    buf.writeFloatLE(24406.5, 8);
    buf.writeInt32LE(1783336800, 12);

    const [p] = decodeDhanBuffer(buf);
    const spotId = makeInstrumentId('NSE', 'NIFTY_SPOT');
    const tick = dhanPacketToTick(p!, 1_783_317_058_000, new Map([['13', spotId]]));

    expect(tick).not.toBeNull();
    expect(tick!.ts).toBe(1_783_317_000_000);
  });

  it('clamps still-future Dhan ltt values to receive time', () => {
    const buf = Buffer.alloc(16, 0);
    makeHeader(buf, 1, 16, 0, 13);
    buf.writeFloatLE(24406.5, 8);
    buf.writeInt32LE(1783336800, 12);

    const [p] = decodeDhanBuffer(buf);
    const spotId = makeInstrumentId('NSE', 'NIFTY_SPOT');
    const tick = dhanPacketToTick(p!, 1_783_000_000_000, new Map([['13', spotId]]));

    expect(tick).not.toBeNull();
    expect(tick!.ts).toBe(1_783_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// Code 2 — LTP only (16 bytes)
// ---------------------------------------------------------------------------

describe('code 2 — LTP packet', () => {
  it('decodes ltp and ltt correctly', () => {
    const buf = Buffer.alloc(16, 0);
    makeHeader(buf, 2, 16, 2, 35022);
    buf.writeFloatLE(247.5, 8);   // ltp in rupees
    buf.writeInt32LE(1782000000, 12); // ltt (unix seconds)

    const packets = decodeDhanBuffer(buf);
    expect(packets.length).toBe(1);
    const p = packets[0]!;
    expect(p.code).toBe(2);
    expect(p.exchangeSegment).toBe('NSE_FNO');
    expect(p.securityId).toBe('35022');
    if (p.code === 2) {
      expect((p as DhanLtpPacket).ltp).toBeCloseTo(247.5, 3);
      expect((p as DhanLtpPacket).ltt).toBe(1782000000);
    }
  });

  it('segment code 1 → NSE_EQ', () => {
    const buf = Buffer.alloc(16, 0);
    makeHeader(buf, 2, 16, 1, 999);
    buf.writeFloatLE(100, 8);
    const [p] = decodeDhanBuffer(buf);
    expect(p?.exchangeSegment).toBe('NSE_EQ');
  });

  it('unknown segment code → SEG_99', () => {
    const buf = Buffer.alloc(16, 0);
    makeHeader(buf, 2, 16, 99, 1);
    buf.writeFloatLE(1, 8);
    const [p] = decodeDhanBuffer(buf);
    expect(p?.exchangeSegment).toBe('SEG_99');
  });
});

// ---------------------------------------------------------------------------
// Code 4 — Quote packet (50 bytes)
// ---------------------------------------------------------------------------

describe('code 4 — Quote packet', () => {
  function makeCode4(ltp: number, qty: number, ltt: number, volume: number, buyQty: number, sellQty: number): Buffer {
    const buf = Buffer.alloc(50, 0);
    makeHeader(buf, 4, 50, 2, 35023);
    buf.writeFloatLE(ltp, 8);
    buf.writeInt16LE(qty, 12);
    buf.writeInt32LE(ltt, 14);
    buf.writeFloatLE(ltp * 1.01, 18); // atp slightly above ltp
    buf.writeInt32LE(volume, 22);
    buf.writeInt32LE(sellQty, 26);
    buf.writeInt32LE(buyQty, 30);
    buf.writeFloatLE(ltp * 0.98, 34); // dayOpen
    buf.writeFloatLE(ltp * 0.97, 38); // dayClose
    buf.writeFloatLE(ltp * 1.03, 42); // dayHigh
    buf.writeFloatLE(ltp * 0.95, 46); // dayLow
    return buf;
  }

  it('decodes all quote fields', () => {
    const buf = makeCode4(185.75, 65, 1782000100, 650, 325, 325);
    const [p] = decodeDhanBuffer(buf);
    expect(p?.code).toBe(4);
    if (p?.code === 4) {
      const q = p as DhanQuotePacket;
      expect(q.ltp).toBeCloseTo(185.75, 3);
      expect(q.qty).toBe(65);
      expect(q.ltt).toBe(1782000100);
      expect(q.volume).toBe(650);
      expect(q.buyQty).toBe(325);
      expect(q.sellQty).toBe(325);
      expect(q.dayOpen).toBeCloseTo(185.75 * 0.98, 2);
      expect(q.dayHigh).toBeCloseTo(185.75 * 1.03, 2);
      expect(q.dayLow).toBeCloseTo(185.75 * 0.95, 2);
    }
  });

  it('securityId is a string', () => {
    const buf = makeCode4(100, 65, 0, 65, 65, 65);
    const [p] = decodeDhanBuffer(buf);
    expect(typeof p?.securityId).toBe('string');
    expect(p?.securityId).toBe('35023');
  });
});

// ---------------------------------------------------------------------------
// Code 8 — Full packet with depth (162 bytes for 5 levels)
// ---------------------------------------------------------------------------

describe('code 8 — Full packet with depth', () => {
  function makeCode8(): Buffer {
    const buf = Buffer.alloc(162, 0);
    makeHeader(buf, 8, 162, 2, 35022);
    buf.writeFloatLE(300.0, 8);   // ltp
    buf.writeInt16LE(130, 12);    // qty
    buf.writeInt32LE(1782001000, 14); // ltt
    buf.writeFloatLE(299.5, 18);  // atp
    buf.writeInt32LE(5000, 22);   // volume
    buf.writeInt32LE(1000, 26);   // sellQty
    buf.writeInt32LE(2000, 30);   // buyQty
    buf.writeInt32LE(50000, 34);  // oi
    buf.writeInt32LE(60000, 38);  // highOi
    buf.writeInt32LE(40000, 42);  // lowOi
    buf.writeFloatLE(290.0, 46);  // dayOpen
    buf.writeFloatLE(280.0, 50);  // dayClose
    buf.writeFloatLE(310.0, 54);  // dayHigh
    buf.writeFloatLE(275.0, 58);  // dayLow

    // 5 depth levels starting at offset 62, 20 bytes each.
    for (let i = 0; i < 5; i++) {
      const off = 62 + i * 20;
      buf.writeInt32LE(100 + i * 10, off);      // bidQty
      buf.writeInt32LE(100 - i * 5, off + 4);  // askQty
      buf.writeInt16LE(3, off + 8);             // bidOrders
      buf.writeInt16LE(4, off + 10);            // askOrders
      buf.writeFloatLE(300 - (i + 1) * 0.05, off + 12); // bidPrice
      buf.writeFloatLE(300 + (i + 1) * 0.05, off + 16); // askPrice
    }
    return buf;
  }

  it('decodes ltp, oi, volume and depth levels', () => {
    const buf = makeCode8();
    const [p] = decodeDhanBuffer(buf);
    expect(p?.code).toBe(8);
    if (p?.code === 8) {
      const f = p as DhanFullPacket;
      expect(f.ltp).toBeCloseTo(300.0, 3);
      expect(f.oi).toBe(50000);
      expect(f.highOi).toBe(60000);
      expect(f.volume).toBe(5000);
      expect(f.depth.length).toBe(5);
      expect(f.depth[0]?.bidQty).toBe(100);
      expect(f.depth[0]?.askQty).toBe(100);
      expect(f.depth[0]?.bidPrice).toBeCloseTo(299.95, 3);
      expect(f.depth[0]?.askPrice).toBeCloseTo(300.05, 3);
      expect(f.depth[4]?.bidQty).toBe(140);
    }
  });

  it('normalizes best depth level to canonical Tick top of book', () => {
    const [packet] = decodeDhanBuffer(makeCode8());
    expect(packet?.code).toBe(8);
    const instrId = makeInstrumentId('NSE', '35022');
    const tick = dhanPacketToTick(packet!, 1_782_001_001_000, new Map([['35022', instrId]]));

    expect(tick).not.toBeNull();
    expect(tick!.instrumentId).toBe(instrId);
    expect(tick!.ltpPaise).toBe(30_000);
    expect(tick!.ts).toBe(1_782_001_000_000);
    expect(tick!.bidPaise).toBe(29_995);
    expect(tick!.askPaise).toBe(30_005);
    expect(tick!.bidQty).toBe(100);
    expect(tick!.askQty).toBe(100);
    expect(tick!.oi).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// Code 5 — OI packet
// ---------------------------------------------------------------------------

describe('code 5 — OI packet', () => {
  it('decodes oi field', () => {
    const buf = Buffer.alloc(12, 0);
    makeHeader(buf, 5, 12, 2, 99);
    buf.writeInt32LE(123456, 8);
    const [p] = decodeDhanBuffer(buf);
    expect(p?.code).toBe(5);
    if (p?.code === 5) expect((p as DhanOiPacket).oi).toBe(123456);
  });
});

// ---------------------------------------------------------------------------
// Code 50 — Disconnect packet
// ---------------------------------------------------------------------------

describe('code 50 — disconnect packet', () => {
  it('decodes disconnectReason', () => {
    const buf = Buffer.alloc(12, 0);
    makeHeader(buf, 50, 12, 0, 0);
    buf.writeInt32LE(7, 8);
    const [p] = decodeDhanBuffer(buf);
    expect(p?.code).toBe(50);
    if (p?.code === 50) expect((p as DhanDisconnectPacket).disconnectReason).toBe(7);
  });

  it('disconnectReason = 0 if buffer shorter than 12', () => {
    const buf = Buffer.alloc(8, 0);
    makeHeader(buf, 50, 8, 0, 0);
    const [p] = decodeDhanBuffer(buf);
    expect(p?.code).toBe(50);
    if (p?.code === 50) expect((p as DhanDisconnectPacket).disconnectReason).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-packet frame
// ---------------------------------------------------------------------------

describe('multi-packet frame', () => {
  it('decodes two consecutive packets in one buffer', () => {
    const p1 = Buffer.alloc(16, 0);
    makeHeader(p1, 2, 16, 2, 100);
    p1.writeFloatLE(100.0, 8);
    p1.writeInt32LE(1, 12);

    const p2 = Buffer.alloc(16, 0);
    makeHeader(p2, 2, 16, 2, 200);
    p2.writeFloatLE(200.0, 8);
    p2.writeInt32LE(2, 12);

    const combined = Buffer.concat([p1, p2]);
    const packets = decodeDhanBuffer(combined);
    expect(packets.length).toBe(2);
    expect(packets[0]?.securityId).toBe('100');
    expect(packets[1]?.securityId).toBe('200');
    if (packets[0]?.code === 2) expect((packets[0] as DhanLtpPacket).ltp).toBeCloseTo(100, 3);
    if (packets[1]?.code === 2) expect((packets[1] as DhanLtpPacket).ltp).toBeCloseTo(200, 3);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('empty buffer returns empty array', () => {
    expect(decodeDhanBuffer(Buffer.alloc(0))).toEqual([]);
    expect(decodeDhanBuffer(new ArrayBuffer(0))).toEqual([]);
  });

  it('JSON fallback for non-binary text messages', () => {
    const msg = JSON.stringify({ RequestCode: 50, Message: 'Goodbye' });
    const result = decodeDhanBuffer(Buffer.from(msg));
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('ArrayBuffer input works (Node 22 native WS emits ArrayBuffer)', () => {
    const ab = new ArrayBuffer(16);
    const view = new DataView(ab);
    view.setUint8(0, 2);          // code
    view.setUint16(1, 16, true);  // length LE
    view.setUint8(3, 2);          // NSE_FNO
    view.setUint32(4, 42, true);  // secId LE
    view.setFloat32(8, 99.5, true); // ltp LE
    view.setInt32(12, 999, true); // ltt LE
    const packets = decodeDhanBuffer(ab);
    expect(packets.length).toBe(1);
    expect(packets[0]?.code).toBe(2);
    if (packets[0]?.code === 2) expect((packets[0] as DhanLtpPacket).ltp).toBeCloseTo(99.5, 2);
  });

  it('truncated known packets do not throw', () => {
    const shortQuote = Buffer.alloc(20, 0);
    makeHeader(shortQuote, 4, 20, 2, 123);

    expect(() => decodeDhanBuffer(shortQuote)).not.toThrow();
    const [p] = decodeDhanBuffer(shortQuote);
    expect(p?.code).toBe(4);
    expect('payload' in (p ?? {})).toBe(true);
  });
});
