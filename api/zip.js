// Minimal streaming ZIP writer/reader — no dependencies.
// Entries are written one at a time straight to the file descriptor, so a
// bundle of several 25 MB traces never has to sit in memory at once.
// Already-compressed files (.zip, .png) are STORED; everything else DEFLATED.
const fs = require('fs');
const zlib = require('zlib');

const DOS_EPOCH = (() => {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
})();

function writeZip(outFile, entries) {
  // entries: [{ name: 'en_US/T1/shots/01-x.png', file: '/abs/path' } | { name, data: Buffer|string }]
  const tmp = `${outFile}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  const central = [];
  let offset = 0;
  const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const entry of entries) {
      const raw = entry.file ? fs.readFileSync(entry.file) : Buffer.from(entry.data);
      const store = /\.(zip|png|jpe?g|gz)$/i.test(entry.name);
      const body = store ? raw : zlib.deflateRawSync(raw, { level: 6 });
      const crc = zlib.crc32(raw) >>> 0;
      const name = Buffer.from(entry.name, 'utf8');
      const method = store ? 0 : 8;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);              // version needed
      local.writeUInt16LE(0x0800, 6);          // flag: UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(DOS_EPOCH.time, 10);
      local.writeUInt16LE(DOS_EPOCH.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const headerOffset = offset;
      write(local); write(name); write(body);
      central.push({ name, method, crc, csize: body.length, usize: raw.length, headerOffset });
    }
    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(DOS_EPOCH.time, 12); h.writeUInt16LE(DOS_EPOCH.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.usize, 24);
      h.writeUInt16LE(c.name.length, 28);
      h.writeUInt32LE(c.headerOffset, 42);
      write(h); write(c.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, outFile);
}

// List entry names (and read one) — used by tests and to verify bundles.
function readZip(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries[name] = () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    };
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

module.exports = { writeZip, readZip };
