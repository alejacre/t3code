#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_PATHS = [
  "bin/node",
  "include/node",
  "lib/node_modules/npm/package.json",
];

function fingerprintEntry(hash, root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stat = fs.lstatSync(absolutePath);
  hash.update(relativePath);
  hash.update("\0");
  hash.update(`mode:${stat.mode & 0o7777}`);
  hash.update("\0");

  if (stat.isSymbolicLink()) {
    hash.update(`link:${fs.readlinkSync(absolutePath)}`);
    hash.update("\0");
    return;
  }
  if (stat.isDirectory()) {
    hash.update("directory\0");
    for (const child of fs.readdirSync(absolutePath).sort()) {
      fingerprintEntry(hash, root, path.posix.join(relativePath, child));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Unsupported Node distribution entry: ${absolutePath}`);
  }
  hash.update(fs.readFileSync(absolutePath));
  hash.update("\0");
}

export function nodeDistributionFingerprint(root) {
  const resolvedRoot = fs.realpathSync.native(root);
  const hash = crypto.createHash("sha256");
  for (const relativePath of REQUIRED_PATHS) {
    fingerprintEntry(hash, resolvedRoot, relativePath);
  }
  return hash.digest("hex");
}

const invokedPath = process.argv[1] ? fs.realpathSync.native(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error("Usage: node node-distribution-fingerprint.mjs <node-distribution-root>");
    process.exitCode = 2;
  } else {
    console.log(nodeDistributionFingerprint(root));
  }
}
