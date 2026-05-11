#!/usr/bin/env node
/* global URL */
/**
 * scripts/rename-cjs.mjs
 *
 * Renames all .js files in dist/cjs to .cjs so Node.js can unambiguously
 * identify them as CommonJS modules when `"type": "module"` is set in
 * package.json.
 *
 * Also rewrites local require() calls, sourceMappingURL trailers, and source map
 * `file` fields so inter-module references and debugger source maps remain
 * valid after renaming.
 *
 * Run after `tsc -p tsconfig.cjs.json`.
 */

import { readdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CJS_DIR = fileURLToPath(new URL("./dist/cjs/", import.meta.url));
const jsFiles = readdirSync(CJS_DIR).filter((file) => extname(file) === ".js");

// Step 1: rewrite internal .js references and source map trailers.
for (const file of jsFiles) {
  const filePath = join(CJS_DIR, file);
  const src = readFileSync(filePath, "utf8");
  const rewritten = src
    // Matches: require('./foo.js') or require('../foo.js')
    .replace(
      /require\((['"])(\.\.?\/[^'"]+)\.js\1\)/g,
      (_, quote, path) => `require(${quote}${path}.cjs${quote})`,
    )
    .replace(/\/\/# sourceMappingURL=([^\s]+)\.js\.map/g, "//# sourceMappingURL=$1.cjs.map");

  if (rewritten !== src) writeFileSync(filePath, rewritten, "utf8");
}

// Step 2: rename .js -> .cjs.
for (const file of jsFiles) {
  const from = join(CJS_DIR, file);
  const to = join(CJS_DIR, file.replace(/\.js$/, ".cjs"));
  renameSync(from, to);
}

// Step 3: update and rename sourcemaps too (.js.map -> .cjs.map).
const mapFiles = readdirSync(CJS_DIR).filter((file) => file.endsWith(".js.map"));
for (const file of mapFiles) {
  const from = join(CJS_DIR, file);
  const raw = readFileSync(from, "utf8");
  try {
    const map = JSON.parse(raw);
    if (typeof map.file === "string") {
      map.file = map.file.replace(/\.js$/, ".cjs");
      writeFileSync(from, `${JSON.stringify(map)}\n`, "utf8");
    }
  } catch {
    // Leave malformed maps untouched; the rename below still preserves them.
  }

  const to = join(CJS_DIR, file.replace(/\.js\.map$/, ".cjs.map"));
  renameSync(from, to);
}
