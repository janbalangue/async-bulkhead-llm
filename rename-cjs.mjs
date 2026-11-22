#!/usr/bin/env node
/* global URL */
/**
 * scripts/rename-cjs.mjs
 *
 * Renames all .js files in dist/cjs to .cjs so Node.js can unambiguously
 * identify them as CommonJS modules when `"type": "module"` is set in
 * package.json. Nested folders such as dist/cjs/engine are included.
 *
 * Also rewrites local require() calls, sourceMappingURL trailers, and source map
 * `file` fields so inter-module references and debugger source maps remain
 * valid after renaming. A require() may point into, out of, or across a
 * nested folder (`./engine/limits.js`, `../types.js`); all are rewritten.
 *
 * Run after `tsc -p tsconfig.cjs.json`.
 */

import { readdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CJS_DIR = fileURLToPath(new URL("./dist/cjs/", import.meta.url));

/** Every file under `dir`, at any depth, whose name ends with `suffix`. */
function findFiles(dir, suffix) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findFiles(path, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      found.push(path);
    }
  }
  return found;
}

const jsFiles = findFiles(CJS_DIR, ".js");

// Step 1: rewrite internal .js references and source map trailers.
for (const filePath of jsFiles) {
  const src = readFileSync(filePath, "utf8");
  const rewritten = src
    // Matches: require('./foo.js'), require('../foo.js'), require('./dir/foo.js')
    .replace(
      /require\((['"])(\.\.?\/[^'"]+)\.js\1\)/g,
      (_, quote, path) => `require(${quote}${path}.cjs${quote})`,
    )
    .replace(/\/\/# sourceMappingURL=([^\s]+)\.js\.map/g, "//# sourceMappingURL=$1.cjs.map");

  if (rewritten !== src) writeFileSync(filePath, rewritten, "utf8");
}

// Step 2: rename .js -> .cjs.
for (const from of jsFiles) {
  renameSync(from, from.replace(/\.js$/, ".cjs"));
}

// Step 3: update and rename sourcemaps too (.js.map -> .cjs.map).
for (const from of findFiles(CJS_DIR, ".js.map")) {
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

  renameSync(from, from.replace(/\.js\.map$/, ".cjs.map"));
}
