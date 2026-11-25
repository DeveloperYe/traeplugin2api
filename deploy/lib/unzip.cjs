// 极简 zip 读取器（不依赖任何第三方库），够用来解 VSIX
// 支持 stored(0) 与 deflate(8) 两种压缩方式
const fs = require("fs");
const zlib = require("zlib");

function readEOCD(fd, size) {
  // EOCD 至少 22 字节，注释最长 65535
  const tailLen = Math.min(size, 22 + 65535);
  const buf = Buffer.alloc(tailLen);
  fs.readSync(fd, buf, 0, tailLen, size - tailLen);
  for (let i = tailLen - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return {
        cdCount: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16),
      };
    }
  }
  throw new Error("不是有效的 zip（找不到 EOCD）");
}

function listEntries(path) {
  const fd = fs.openSync(path, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const { cdCount, cdSize, cdOffset } = readEOCD(fd, size);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < cdCount; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      entries.push({ name, method, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function extractEntry(path, entry, outPath) {
  const fd = fs.openSync(path, "r");
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.localOffset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error("本地头损坏: " + entry.name);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const comp = Buffer.alloc(entry.compSize);
    fs.readSync(fd, comp, 0, entry.compSize, dataStart);
    let out;
    if (entry.method === 0) out = comp;
    else if (entry.method === 8) out = zlib.inflateRawSync(comp);
    else throw new Error("不支持的压缩方式 " + entry.method + ": " + entry.name);
    fs.mkdirSync(require("path").dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, out);
    return out.length;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { listEntries, extractEntry };
