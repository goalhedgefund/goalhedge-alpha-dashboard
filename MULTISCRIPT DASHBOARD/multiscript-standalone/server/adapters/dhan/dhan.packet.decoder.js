function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from([]);
}

function getExchangeSegment(code) {
  const map = {
    1: 'NSE_EQ',
    2: 'NSE_FNO',
    3: 'BSE_EQ',
    4: 'BSE_FNO',
    5: 'MCX_COMM',
    6: 'NSE_CURR',
    7: 'BSE_CURR'
  };
  return map[code] || `SEG_${code}`;
}

function readPacketHeader(buffer) {
  return {
    code: buffer.readUInt8(0),
    length: buffer.readUInt16LE(1),
    exchangeSegment: getExchangeSegment(buffer.readUInt8(3)),
    securityId: String(buffer.readUInt32LE(4))
  };
}

function decodePacket(buffer) {
  const packet = readPacketHeader(buffer);
  const result = { ...packet, rawLength: buffer.length };

  switch (packet.code) {
    case 2:
      result.ltp = buffer.readFloatLE(8);
      result.ltt = buffer.readInt32LE(12);
      break;
    case 4:
      result.ltp = buffer.readFloatLE(8);
      result.qty = buffer.readInt16LE(12);
      result.ltt = buffer.readInt32LE(14);
      result.atp = buffer.readFloatLE(18);
      result.volume = buffer.readInt32LE(22);
      result.sellQty = buffer.readInt32LE(26);
      result.buyQty = buffer.readInt32LE(30);
      result.dayOpen = buffer.readFloatLE(34);
      result.dayClose = buffer.readFloatLE(38);
      result.dayHigh = buffer.readFloatLE(42);
      result.dayLow = buffer.readFloatLE(46);
      break;
    case 5:
      result.oi = buffer.readInt32LE(8);
      break;
    case 6:
      result.prevClose = buffer.readFloatLE(8);
      result.prevOi = buffer.readInt32LE(12);
      break;
    case 8:
      result.ltp = buffer.readFloatLE(8);
      result.qty = buffer.readInt16LE(12);
      result.ltt = buffer.readInt32LE(14);
      result.atp = buffer.readFloatLE(18);
      result.volume = buffer.readInt32LE(22);
      result.sellQty = buffer.readInt32LE(26);
      result.buyQty = buffer.readInt32LE(30);
      result.oi = buffer.readInt32LE(34);
      result.highOi = buffer.readInt32LE(38);
      result.lowOi = buffer.readInt32LE(42);
      result.dayOpen = buffer.readFloatLE(46);
      result.dayClose = buffer.readFloatLE(50);
      result.dayHigh = buffer.readFloatLE(54);
      result.dayLow = buffer.readFloatLE(58);
      result.depth = [];
      for (let i = 62; i + 20 <= Math.min(buffer.length, 162); i += 20) {
        result.depth.push({
          bidQty: buffer.readInt32LE(i),
          askQty: buffer.readInt32LE(i + 4),
          bidOrders: buffer.readInt16LE(i + 8),
          askOrders: buffer.readInt16LE(i + 10),
          bidPrice: buffer.readFloatLE(i + 12),
          askPrice: buffer.readFloatLE(i + 16)
        });
      }
      break;
    case 50:
      result.disconnectReason = buffer.length >= 12 ? buffer.readInt32LE(8) : 0;
      break;
    default:
      result.payload = buffer.subarray(8);
      break;
  }

  return result;
}

function decodeDhanBuffer(data) {
  const buffer = toBuffer(data);
  if (!buffer.length) return [];

  const packets = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt16LE(offset + 1) || buffer.length - offset;
    const packetLength = Math.max(8, Math.min(length, buffer.length - offset));
    const slice = buffer.subarray(offset, offset + packetLength);
    if (slice.length < 8) break;
    packets.push(decodePacket(slice));
    offset += packetLength;
    if (packetLength <= 0) break;
  }

  if (!packets.length) {
    try {
      const text = buffer.toString('utf8');
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      return [{
        code: 0,
        length: buffer.length,
        exchangeSegment: 'UNKNOWN',
        securityId: '',
        raw: buffer
      }];
    }
  }

  return packets;
}

module.exports = {
  decodeDhanBuffer,
  readPacketHeader,
  toBuffer
};
