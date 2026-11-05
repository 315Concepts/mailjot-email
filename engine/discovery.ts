import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Entry files in lookup order: TSX in development, compiled JS in production. */
const ENTRY_FILES = ["index.tsx", "index.js"];

export class TemplateNotFoundError extends Error {
  constructor(public readonly requested: string) {
    super(`Template not found: ${requested}`);
    this.name = "TemplateNotFoundError";
  }
}

export interface TemplateLocation {
  id: string;
  entryPath: string;
}

async function findEntry(dir: string): Promise<string | undefined> {
  for (const name of ENTRY_FILES) {
    const candidate = path.join(dir, name);
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile()) return candidate;
  }
  return undefined;
}

/**
 * Directories that are never templates: hidden and tooling directories (`.git`, `.cache`) and dependencies
 * (`node_modules`). One rule, used by both listing and resolving a requested path, so what a request can
 * reach never differs from what is listed. Case-insensitive, because some filesystems are, and
 * `Node_Modules/pkg` would otherwise reach `node_modules/pkg` there.
 */
export function isSkippedDirectory(name: string): boolean {
  return name.startsWith(".") || name.toLowerCase() === "node_modules";
}

/** Scans `root` for directories containing an entry file. The relative directory path is the template ID. */
export async function discoverTemplates(root: string): Promise<TemplateLocation[]> {
  const found: TemplateLocation[] = [];

  async function walk(dir: string): Promise<void> {
    const entryPath = await findEntry(dir);
    if (entryPath) {
      found.push({ id: path.relative(root, dir).split(path.sep).join("/"), entryPath });
      return; // a template directory is a leaf
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !isSkippedDirectory(entry.name)) {
        await walk(path.join(dir, entry.name));
      }
    }
  }

  await walk(root);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

const SEGMENT = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Maps an untrusted API path (e.g. "accounts/welcome") to a template on disk.
 * Anything malformed, escaping the root, or without an entry file is "not found".
 */
export async function resolveTemplate(root: string, requested: string): Promise<TemplateLocation> {
  const segments = requested.split("/");
  if (segments.length === 0 || !segments.every((s) => SEGMENT.test(s)) || segments.some(isSkippedDirectory)) {
    throw new TemplateNotFoundError(requested);
  }

  const dir = path.join(root, ...segments);
  const entryPath = await findEntry(dir);
  if (!entryPath) throw new TemplateNotFoundError(requested);

  // Defend against symlinks that point outside the templates root.
  const [realRoot, realEntry] = await Promise.all([realpath(root), realpath(entryPath)]);
  if (!realEntry.startsWith(realRoot + path.sep)) throw new TemplateNotFoundError(requested);

  return { id: segments.join("/"), entryPath };
}
