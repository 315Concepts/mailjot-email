import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Storybook previews import these files and run them in the browser, so they must not use Node-only
// globals or modules. The static Storybook build hides some of this (it substitutes `process.env.*`
// at build time); the dev server does not, and fails at runtime with "process is not defined".
const BROWSER_FILES = ["render", "integrity", "schema", "validation", "errors", "template"];

const NODE_ONLY: [string, RegExp][] = [
  ["`process`", /\bprocess\b(?!ing)/],
  ["`Buffer`", /\bBuffer\b/],
  ["`NodeJS.` types", /\bNodeJS\./],
  ["`__dirname` / `__filename`", /\b__(dirname|filename)\b/],
  ["`require(`", /\brequire\(/],
  ["a `node:` import", /from\s+["']node:/],
  ["an `fs`/`path`/`os` import", /from\s+["'](fs|path|os|crypto|child_process)(\/[^"']*)?["']/],
];

/** Strips comments so a mention in prose does not count. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// The logger and the request log are Node-only (they use `node:` modules and pino). A browser-safe file must not
// reach them, not even through a type import: the render path reports problems by throwing, and the routers log.
const LOGGING_IMPORT = /\b(?:import|export)\b[^;]*?\bfrom\s+["'](?:\.\/logger|\.\/requestLog|pino)(?:\.js)?["']/;

describe("browser-safe engine modules", () => {
  it.each(BROWSER_FILES)("%s.ts does not import the logger, the request log or pino", async (name) => {
    const source = code(await readFile(fileURLToPath(new URL(`./${name}.ts`, import.meta.url)), "utf8"));
    expect(LOGGING_IMPORT.test(source), `${name}.ts must not import the logger`).toBe(false);
  });

  it("detects an import of the logger, as a value or a type, and of pino", () => {
    for (const line of [
      'import { createLogger } from "./logger.js";',
      'import type { Logger } from "./logger.js";',
      "import pino from 'pino';",
      'import { requestLog } from "./requestLog.js";',
      'export { redact } from "./logger";',
    ]) {
      expect(LOGGING_IMPORT.test(line), line).toBe(true);
    }
    expect(LOGGING_IMPORT.test('import { z } from "zod";\nimport type { Foo } from "./template.js";')).toBe(false);
  });

  it.each(BROWSER_FILES)("%s.ts uses no Node-only globals or modules", async (name) => {
    const source = code(await readFile(fileURLToPath(new URL(`./${name}.ts`, import.meta.url)), "utf8"));
    for (const [label, pattern] of NODE_ONLY) {
      expect(pattern.test(source), `${name}.ts must not use ${label}`).toBe(false);
    }
  });

  it("detects a violation", () => {
    expect(NODE_ONLY.some(([, p]) => p.test(code("const t = Number(process.env.X);")))).toBe(true);
    expect(NODE_ONLY.some(([, p]) => p.test(code("// uses process in a comment\nconst a = 1;")))).toBe(false);
  });
});
