#!/usr/bin/env node
// build-xpi.mjs — packages the add-on into release/sortana-<version>.xpi
//
// Equivalent to build-xpi.sh, but the ZIP archive is written with Node's
// built-in zlib instead of shelling out to `zip`, so the build also works on
// machines without the zip binary — or without jq and python3 to read the
// version out of the manifest.
//
//   node build-xpi.mjs              # package the repository this script is in
//   node build-xpi.mjs /path/to/repo
//   node build-xpi.mjs --quiet      # only report the result
//
// The archive is read back and verified before the script reports success.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';

const EXCLUDED_DIRS = new Set(['.git', '.vs', '.claude', 'release']);
const EXCLUDED_EXTENSIONS = new Set(['.sln', '.ps1', '.sh']);
// The build scripts themselves are not part of the add-on.
const EXCLUDED_NAMES = new Set(['build-xpi.sh', 'build-xpi.ps1', 'build-xpi.mjs']);

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const positional = args.filter(arg => !arg.startsWith('--'));
const root = resolveRoot(positional[0]);
const log = (...parts) => { if (!quiet) console.log(...parts); };

function resolveRoot(candidate) {
    if (candidate) return join(process.cwd(), candidate);
    // The repository this script lives in.
    return dirname(fileURLToPath(import.meta.url));
}

// --- locate the manifest ----------------------------------------------------

const manifestPath = join(root, 'manifest.json');
if (!existsSync(manifestPath)) {
    console.error(`manifest.json not found at ${manifestPath}`);
    process.exit(1);
}
const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
if (!version) {
    console.error('No version found in manifest.json');
    process.exit(1);
}

const releaseDir = join(root, 'release');
const xpiPath = join(releaseDir, `sortana-${version}.xpi`);

// --- collect the files ------------------------------------------------------

function collect(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDED_DIRS.has(entry.name)) continue;
            collect(full, out);
        } else if (entry.isFile()) {
            if (EXCLUDED_NAMES.has(entry.name)) continue;
            const dot = entry.name.lastIndexOf('.');
            const extension = dot >= 0 ? entry.name.slice(dot) : '';
            if (EXCLUDED_EXTENSIONS.has(extension)) continue;
            out.push(full);
        }
    }
    return out;
}

const files = collect(root).sort();
if (files.length === 0) {
    console.error('No files found to package.');
    process.exit(0);
}
for (const full of files) {
    const relativePath = relative(root, full).split(sep).join('/');
    log(`Zipping: ${relativePath} <- ${full} (${statSync(full).size} bytes)`);
}

// --- write the archive ------------------------------------------------------

function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time & 0xffff, date: day & 0xffff };
}

const localParts = [];
const centralParts = [];
let offset = 0;

for (const full of files) {
    const relativePath = relative(root, full).split(sep).join('/');
    const nameBuffer = Buffer.from(relativePath, 'utf8');
    const data = readFileSync(full);
    const { time, date } = dosDateTime(statSync(full).mtime);
    const deflated = deflateRawSync(data, { level: 9 });
    // Keep the stored form when deflating does not help, which also keeps
    // empty files valid.
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // local file header signature
    local.writeUInt16LE(20, 4);              // version needed to extract
    local.writeUInt16LE(0, 6);               // general purpose flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);              // extra field length
    localParts.push(local, nameBuffer, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);    // central directory signature
    central.writeUInt16LE(20, 4);            // version made by
    central.writeUInt16LE(20, 6);            // version needed to extract
    central.writeUInt16LE(0, 8);             // general purpose flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);            // extra field length
    central.writeUInt16LE(0, 32);            // file comment length
    central.writeUInt16LE(0, 34);            // disk number start
    central.writeUInt16LE(0, 36);            // internal file attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external file attributes
    central.writeUInt32LE(offset, 42);       // relative offset of local header
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + payload.length;
}

const centralDirectory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);           // end of central directory signature
end.writeUInt16LE(0, 4);                     // number of this disk
end.writeUInt16LE(0, 6);                     // disk with the start of the directory
end.writeUInt16LE(files.length, 8);          // entries on this disk
end.writeUInt16LE(files.length, 10);         // entries in total
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(offset, 16);               // offset of the central directory
end.writeUInt16LE(0, 20);                    // comment length

mkdirSync(releaseDir, { recursive: true });
rmSync(xpiPath, { force: true });
writeFileSync(xpiPath, Buffer.concat([...localParts, centralDirectory, end]));

// --- verify the archive -----------------------------------------------------

function verify(path) {
    const buffer = readFileSync(path);
    let endOffset = -1;
    for (let i = buffer.length - 22; i >= 0; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { endOffset = i; break; }
    }
    if (endOffset < 0) throw new Error('no end of central directory record');
    if (endOffset !== buffer.length - 22) throw new Error('trailing data after the archive');

    const entryCount = buffer.readUInt16LE(endOffset + 10);
    const directorySize = buffer.readUInt32LE(endOffset + 12);
    const directoryOffset = buffer.readUInt32LE(endOffset + 16);
    if (directoryOffset + directorySize !== endOffset) throw new Error('inconsistent central directory offsets');

    let cursor = directoryOffset;
    let checked = 0;
    for (let i = 0; i < entryCount; i += 1) {
        if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`bad central header for entry ${i}`);
        const method = buffer.readUInt16LE(cursor + 10);
        const checksum = buffer.readUInt32LE(cursor + 16) >>> 0;
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const rawSize = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name}: bad local header`);
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
        const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
        if (data.length !== rawSize) throw new Error(`${name}: size mismatch`);
        if ((crc32(data) >>> 0) !== checksum) throw new Error(`${name}: CRC mismatch`);
        checked += 1;

        cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (checked !== entryCount) throw new Error('not every entry was verified');
    return checked;
}

let verified = 0;
try {
    verified = verify(xpiPath);
} catch (error) {
    console.error(`The produced archive failed verification: ${error.message}`);
    rmSync(xpiPath, { force: true });
    process.exit(1);
}

console.log(`Built XPI at: ${xpiPath}`);
console.log(`Version: ${version}`);
console.log(`Files: ${files.length} (${verified} verified)`);
