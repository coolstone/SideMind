// Minimal deterministic ZIP writer for the small extension bundle; UTF-8 names on every OS.
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
const [output, ...inputs] = process.argv.slice(2);
if (!output || !inputs.length) throw new Error("Usage: node create-zip.mjs output.zip files...");
const files = [];
function collect(filename) {
  const info = fs.lstatSync(filename);
  if (info.isSymbolicLink()) throw new Error(`Refusing symlink: ${filename}`);
  if (info.isDirectory()) {
    for (const child of fs.readdirSync(filename).sort()) if (child !== ".DS_Store") collect(path.join(filename, child));
  } else if (info.isFile()) files.push(filename);
}
inputs.forEach(collect);
const table = Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const localParts = [], directory = [];
let offset = 0;
for (const filename of [...new Set(files)].sort()) {
  const name = Buffer.from(filename.split(path.sep).join("/"), "utf8");
  const data = fs.readFileSync(filename);
  const compressed = deflateRawSync(data);
  if (name.length > 65535 || data.length > 0xffffffff) throw new Error("ZIP entry too large");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6); // UTF-8 filename
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(33, 12); // 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 30);
  central.writeUInt32LE(offset, 42);
  localParts.push(local, name, compressed);
  directory.push(central, name);
  offset += local.length + name.length + compressed.length;
}
const directorySize = directory.reduce((size, part) => size + part.length, 0);
if (files.length > 65535 || offset + directorySize > 0xffffffff) throw new Error("Bundle requires ZIP64; unsupported");
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(directory.length / 2, 8);
end.writeUInt16LE(directory.length / 2, 10);
end.writeUInt32LE(directorySize, 12);
end.writeUInt32LE(offset, 16);
fs.writeFileSync(output, Buffer.concat([...localParts, ...directory, end]));
