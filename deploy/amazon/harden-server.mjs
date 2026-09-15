import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GUARD_MARKER = "T3CODE_AMAZON_INTERNAL_ONLY_GUARD";
const INTERNAL_ONLY_GUARD = `// ${GUARD_MARKER}
if (process.env.T3CODE_INTERNAL_ONLY !== "1") {
  throw new Error("The Amazon runtime requires T3CODE_INTERNAL_ONLY=1.");
}
`;

export function hardenServerEntry(source) {
  if (source.includes(GUARD_MARKER)) {
    return source;
  }
  if (source.startsWith("#!")) {
    const lineEnd = source.indexOf("\n");
    if (lineEnd === -1) {
      return `${source}\n${INTERNAL_ONLY_GUARD}`;
    }
    return `${source.slice(0, lineEnd + 1)}${INTERNAL_ONLY_GUARD}${source.slice(lineEnd + 1)}`;
  }
  return `${INTERNAL_ONLY_GUARD}${source}`;
}

function main() {
  const filePath = path.resolve(process.argv[2] ?? "");
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Pass the built server entry path.");
  }
  fs.writeFileSync(filePath, hardenServerEntry(fs.readFileSync(filePath, "utf8")));
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main();
}
