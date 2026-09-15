import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hardenServerEntry } from "./harden-server.mjs";

test("injects the Amazon internal-only guard exactly once after a shebang", () => {
  const source = "#!/usr/bin/env node\nconsole.log('started');\n";
  const hardened = hardenServerEntry(source);
  assert.match(hardened, /^#!\/usr\/bin\/env node\n\/\/ T3CODE_AMAZON_INTERNAL_ONLY_GUARD/u);
  assert.equal(hardenServerEntry(hardened), hardened);
});

test("packaged entry refuses missing or malformed internal-only mode", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-amazon-entry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "entry.mjs");
  fs.writeFileSync(entry, hardenServerEntry("console.log('started');\n"));

  for (const value of [undefined, "", "true", "0"]) {
    const env = { ...process.env };
    if (value === undefined) {
      delete env.T3CODE_INTERNAL_ONLY;
    } else {
      env.T3CODE_INTERNAL_ONLY = value;
    }
    const result = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
    assert.notEqual(result.status, 0, `unexpectedly accepted ${String(value)}`);
    assert.match(result.stderr, /requires T3CODE_INTERNAL_ONLY=1/u);
  }

  const accepted = spawnSync(process.execPath, [entry], {
    env: { ...process.env, T3CODE_INTERNAL_ONLY: "1" },
    encoding: "utf8",
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout.trim(), "started");
});
