#!/usr/bin/env node
/**
 * scripts/rename-cjs.mjs
 *
 * Renames all .js files in dist/cjs to .cjs so Node.js can unambiguously
 * identify them as CommonJS modules when `"type": "module"` is set in
 * package.json.
 *
 * Also rewrites any require() calls inside them that reference local
 * .js files (e.g. require('./foo.js')) to use .cjs, so inter-module
 * references remain valid after renaming.
 *
 * Run after `tsc -p tsconfig.cjs.json`.
 */

import { readdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

console.log("rename-cjs.mjs running from:", new URL(".", import.meta.url).pathname);

const CJS_DIR = fileURLToPath(new URL("./dist/cjs/", import.meta.url));
console.log("CJS_DIR =", CJS_DIR);

const jsFiles = readdirSync(CJS_DIR).filter(f => extname(f) === '.js');

// Step 1: rewrite internal .js references to .cjs within each file
for (const file of jsFiles) {
  const filePath = join(CJS_DIR, file);
  const src = readFileSync(filePath, 'utf8');
  // Matches: require('./foo.js') or require('../foo.js')
  const rewritten = src.replace(
    /require\((['"])(\.\.?\/[^'"]+)\.js\1\)/g,
    (_, quote, path) => `require(${quote}${path}.cjs${quote})`,
  );
  if (rewritten !== src) writeFileSync(filePath, rewritten, 'utf8');
}

// Step 2: rename .js -> .cjs
for (const file of jsFiles) {
  const from = join(CJS_DIR, file);
  const to   = join(CJS_DIR, file.replace(/\.js$/, '.cjs'));
  renameSync(from, to);
  console.log(`renamed: ${file} -> ${file.replace(/\.js$/, '.cjs')}`);
}

// Step 3: rename sourcemaps too (.js.map -> .cjs.map)
const mapFiles = readdirSync(CJS_DIR).filter(f => f.endsWith('.js.map'));
for (const file of mapFiles) {
  const from = join(CJS_DIR, file);
  const to   = join(CJS_DIR, file.replace(/\.js\.map$/, '.cjs.map'));
  renameSync(from, to);
}

console.log(`\nRenamed ${jsFiles.length} CJS file(s) in ${CJS_DIR}`);
