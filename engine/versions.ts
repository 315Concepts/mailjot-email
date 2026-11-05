import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./logger.js";

export interface VersionDirectory {
  /** Directory name, e.g. "v1". */
  name: string;
  /** Numeric version, e.g. 1. */
  number: number;
  dir: string;
}

const VERSION_DIR = /^v([1-9]\d*)$/;

/**
 * Finds the version directories (`v1`, `v2`, ...) directly under `root`, in ascending order.
 * Other entries are ignored, with a warning for directories that look like a pre-versioning layout.
 * The warning goes to `logger`; callers without one (tests, scripts) get it on the console.
 */
export async function discoverVersions(root: string, logger?: Logger): Promise<VersionDirectory[]> {
  const versions: VersionDirectory[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const match = VERSION_DIR.exec(entry.name);
    if (match) {
      versions.push({ name: entry.name, number: Number(match[1]), dir: path.join(root, entry.name) });
    } else {
      const message = `Ignoring "${entry.name}" in ${root}: not a version directory (expected v1, v2, ...)`;
      if (logger) logger.warn({ event: "mailjot.versions.ignored", root, directory: entry.name }, message);
      else console.warn(message);
    }
  }
  return versions.sort((a, b) => a.number - b.number);
}
