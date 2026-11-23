import fs from "node:fs";
import { inflateRawSync } from "node:zlib";
const [filename, ...required] = process.argv.slice(2);
const archive = fs.readFileSync(filename);
const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (end < 0) throw new Error("Invalid ZIP directory");
const count = archive.readUInt16LE(end + 10);
let cursor = archive.readUInt32LE(end + 16);
const files = new Map();
for (let i = 0; i < count; i++) {
  if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP entry");
  const nameLength = archive.readUInt16LE(cursor + 28);
  const extraLength = archive.readUInt16LE(cursor + 30);
  const commentLength = archive.readUInt16LE(cursor + 32);
  const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
  if (name.startsWith("/") || name.split("/").includes("..") || files.has(name)) throw new Error(`Unsafe or duplicate ZIP path: ${name}`);
  const local = archive.readUInt32LE(cursor + 42);
  const offset = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const compressed = archive.subarray(offset, offset + archive.readUInt32LE(cursor + 20));
  const method = archive.readUInt16LE(cursor + 10);
  if (![0, 8].includes(method)) throw new Error("Unsupported ZIP compression");
  files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
  cursor += 46 + nameLength + extraLength + commentLength;
}
for (const file of required) {
  if (!files.has(file) && ![...files.keys()].some((name) => name.startsWith(file + "/"))) throw new Error(`Package missing ${file}`);
}
const version = JSON.parse(files.get("manifest.json").toString("utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid manifest version");
for (const [name, data] of files) {
  if (!name.endsWith(".html")) continue;
  const html = data.toString("utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))(?:\?[^"\s]*)?"/g)) {
    if (!match[1].includes(":") && !files.has(match[1])) throw new Error(`${name} references missing ${match[1]}`);
  }
}
process.stdout.write(version);
