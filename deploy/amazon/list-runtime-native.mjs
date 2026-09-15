import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ELF_MACHINE_BY_ARCH = { x64: 62, arm64: 183 };
const ELF_SECTION_DYNAMIC = 6;
const ELF_DYNAMIC_NEEDED = 1n;
const ELF_DYNAMIC_NULL = 0n;

function elfMachineForArch(architecture) {
  const machine = ELF_MACHINE_BY_ARCH[architecture];
  if (machine === undefined) {
    throw new Error(
      `Amazon runtime native-artifact verification supports linux-x64 and linux-arm64, received ${architecture}.`,
    );
  }
  return machine;
}

function boundedUint64(bytes, offset) {
  if (offset < 0 || offset + 8 > bytes.length) return null;
  const value = bytes.readBigUInt64LE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function elfNeededLibraries(bytes) {
  const sectionOffset = boundedUint64(bytes, 40);
  if (sectionOffset === null || bytes.length < 64) return null;
  const sectionEntrySize = bytes.readUInt16LE(58);
  const sectionCount = bytes.readUInt16LE(60);
  if (
    sectionEntrySize < 64 ||
    sectionCount === 0 ||
    sectionOffset + sectionEntrySize * sectionCount > bytes.length
  ) {
    return null;
  }

  const needed = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const header = sectionOffset + index * sectionEntrySize;
    if (bytes.readUInt32LE(header + 4) !== ELF_SECTION_DYNAMIC) continue;

    const dynamicOffset = boundedUint64(bytes, header + 24);
    const dynamicSize = boundedUint64(bytes, header + 32);
    const stringSectionIndex = bytes.readUInt32LE(header + 40);
    if (
      dynamicOffset === null ||
      dynamicSize === null ||
      dynamicOffset + dynamicSize > bytes.length ||
      stringSectionIndex >= sectionCount
    ) {
      return null;
    }

    const stringHeader = sectionOffset + stringSectionIndex * sectionEntrySize;
    const stringOffset = boundedUint64(bytes, stringHeader + 24);
    const stringSize = boundedUint64(bytes, stringHeader + 32);
    if (
      stringOffset === null ||
      stringSize === null ||
      stringOffset + stringSize > bytes.length
    ) {
      return null;
    }

    for (let cursor = dynamicOffset; cursor + 16 <= dynamicOffset + dynamicSize; cursor += 16) {
      const tag = bytes.readBigInt64LE(cursor);
      if (tag === ELF_DYNAMIC_NULL) break;
      if (tag !== ELF_DYNAMIC_NEEDED) continue;
      const relativeNameOffset = boundedUint64(bytes, cursor + 8);
      if (relativeNameOffset === null || relativeNameOffset >= stringSize) return null;
      const nameOffset = stringOffset + relativeNameOffset;
      const nameEnd = bytes.indexOf(0, nameOffset);
      if (nameEnd === -1 || nameEnd >= stringOffset + stringSize) return null;
      needed.push(bytes.toString("utf8", nameOffset, nameEnd));
    }
  }
  return needed;
}

export function isAl2RuntimeNative(bytes, architecture = process.arch) {
  const expectedMachine = elfMachineForArch(architecture);
  const hasAl2Header =
    bytes.length >= 20 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46 &&
    bytes[4] === ELF_CLASS_64 &&
    bytes[5] === ELF_DATA_LITTLE_ENDIAN &&
    bytes.readUInt16LE(18) === expectedMachine;
  if (!hasAl2Header) return false;

  const needed = elfNeededLibraries(bytes);
  return (
    needed !== null &&
    needed.every((name) => name !== "libc.so" && !name.startsWith("libc.musl-"))
  );
}

export function listAl2RuntimeNative(root, architecture = process.arch) {
  const matches = [];
  const visit = (directory) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".node") || entry.name.endsWith(".so")) &&
        isAl2RuntimeNative(fs.readFileSync(target), architecture)
      ) {
        matches.push(target);
      }
    }
  };
  visit(root);
  return matches;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error("Usage: node list-runtime-native.mjs <runtime-directory>");
    process.exitCode = 1;
  } else {
    for (const nativePath of listAl2RuntimeNative(path.resolve(root))) {
      process.stdout.write(`${nativePath}\0`);
    }
  }
}
