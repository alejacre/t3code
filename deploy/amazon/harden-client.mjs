import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const INTERNAL_ONLY_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://*.tunnels.lab.aws.dev wss://*.tunnels.lab.aws.dev",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join("; ");

const CSP_MARKER = 'http-equiv="Content-Security-Policy"';

export function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    const attributes = match[1] ?? "";
    const source = match[2] ?? "";
    if (/\bsrc\s*=/iu.test(attributes) || source.length === 0) {
      continue;
    }
    const digest = crypto.createHash("sha256").update(source).digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return [...new Set(hashes)].sort();
}

export function internalOnlyContentSecurityPolicy(html) {
  const scriptHashes = inlineScriptHashes(html);
  if (scriptHashes.length === 0) {
    return INTERNAL_ONLY_CONTENT_SECURITY_POLICY;
  }
  return INTERNAL_ONLY_CONTENT_SECURITY_POLICY.replace(
    "script-src 'self' 'wasm-unsafe-eval'",
    `script-src 'self' 'wasm-unsafe-eval' ${scriptHashes.join(" ")}`,
  );
}

export function hardenClientHtml(html) {
  if (html.includes(CSP_MARKER)) {
    return html;
  }
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (!head) {
    throw new Error("Client HTML does not contain a head element.");
  }
  const csp = `<meta ${CSP_MARKER} content="${internalOnlyContentSecurityPolicy(html)}">`;
  const insertionOffset = head.index + head[0].length;
  return `${html.slice(0, insertionOffset)}\n    ${csp}${html.slice(insertionOffset)}`;
}

function main() {
  const filePath = path.resolve(process.argv[2] ?? "");
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Pass the built client index.html path.");
  }
  const html = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, hardenClientHtml(html));
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main();
}
