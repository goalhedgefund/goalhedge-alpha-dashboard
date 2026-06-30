const fs = require('node:fs');
const path = require('node:path');

function createSelectionStore(filePath) {
  let current = { symbols: [] };

  function ensureDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function read() {
    if (!fs.existsSync(filePath)) return current;
    try {
      current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      current = { symbols: [] };
    }
    return current;
  }

  function write(next) {
    ensureDir();
    current = next;
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
    return current;
  }

  function updateSymbol(symbol, enabledFrames) {
    const data = read();
    const idx = data.symbols.findIndex((item) => item.symbol === symbol);
    if (idx >= 0) {
      data.symbols[idx].enabledFrames = enabledFrames;
    } else {
      data.symbols.push({ symbol, enabledFrames });
    }
    write(data);
    return data;
  }

  return { read, write, updateSymbol, filePath };
}

module.exports = { createSelectionStore };
