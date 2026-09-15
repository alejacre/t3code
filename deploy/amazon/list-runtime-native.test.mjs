import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isAl2RuntimeNative,
  listAl2RuntimeNative,
} from "./list-runtime-native.mjs";

function elfFixture({ machine = 62, elfClass = 2, data = 1, needed = "libc.so.6" } = {}) {
  const bytes = Buffer.alloc(512);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, data]);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeBigUInt64LE(64n, 40);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(3, 60);

  const dynamicHeader = 128;
  bytes.writeUInt32LE(6, dynamicHeader + 4);
  bytes.writeBigUInt64LE(256n, dynamicHeader + 24);
  bytes.writeBigUInt64LE(32n, dynamicHeader + 32);
  bytes.writeUInt32LE(2, dynamicHeader + 40);
  bytes.writeBigUInt64LE(16n, dynamicHeader + 56);

  const stringHeader = 192;
  const stringSize = Buffer.byteLength(needed) + 2;
  bytes.writeUInt32LE(3, stringHeader + 4);
  bytes.writeBigUInt64LE(288n, stringHeader + 24);
  bytes.writeBigUInt64LE(BigInt(stringSize), stringHeader + 32);

  bytes.writeBigInt64LE(1n, 256);
  bytes.writeBigUInt64LE(1n, 264);
  bytes.writeBigInt64LE(0n, 272);
  bytes.write(`\0${needed}\0`, 288);
  return bytes;
}

test("selects only x86_64 glibc ELF artifacts", () => {
  assert.equal(isAl2RuntimeNative(elfFixture(), "x64"), true);
  assert.equal(isAl2RuntimeNative(Buffer.from("MZ"), "x64"), false);
  assert.equal(isAl2RuntimeNative(elfFixture({ machine: 183 }), "x64"), false);
  assert.equal(isAl2RuntimeNative(elfFixture({ elfClass: 1 }), "x64"), false);
  assert.equal(isAl2RuntimeNative(elfFixture({ data: 2 }), "x64"), false);
  assert.equal(
    isAl2RuntimeNative(elfFixture({ needed: "libc.musl-x86_64.so.1" }), "x64"),
    false,
  );
  assert.equal(isAl2RuntimeNative(elfFixture({ needed: "libc.so" }), "x64"), false);
  assert.equal(isAl2RuntimeNative(elfFixture().subarray(0, 80), "x64"), false);
});

test("selects only aarch64 glibc ELF artifacts", () => {
  assert.equal(isAl2RuntimeNative(elfFixture({ machine: 183 }), "arm64"), true);
  assert.equal(isAl2RuntimeNative(elfFixture({ machine: 62 }), "arm64"), false);
  assert.equal(
    isAl2RuntimeNative(elfFixture({ machine: 183, needed: "libc.musl-aarch64.so.1" }), "arm64"),
    false,
  );
});

test("fails closed on unsupported architectures", () => {
  assert.throws(
    () => isAl2RuntimeNative(elfFixture(), "ia32"),
    /supports linux-x64 and linux-arm64/,
  );
});

test("lists loadable runtime native files without following symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-runtime-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "z.node"), elfFixture());
  fs.writeFileSync(path.join(root, "nested", "a.so"), elfFixture());
  fs.writeFileSync(
    path.join(root, "nested", "musl.node"),
    elfFixture({ needed: "libc.musl-x86_64.so.1" }),
  );
  fs.writeFileSync(path.join(root, "ignored.txt"), elfFixture());
  fs.symlinkSync(path.join(root, "z.node"), path.join(root, "linked.node"));

  assert.deepEqual(listAl2RuntimeNative(root, "x64"), [
    path.join(root, "nested", "a.so"),
    path.join(root, "z.node"),
  ]);
});
