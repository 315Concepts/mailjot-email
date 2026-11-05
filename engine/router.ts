import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Router } from "express";
import type { Logger } from "./logger.js";

/**
 * What the engine tells a version's router: which version it is serving and where that version's
 * content lives. The router resolves its own templates, transports and contract from these, so a
 * v1 router loads v1 templates and v1 transports, and a v2 router can do something different.
 */
export interface VersionContext {
  version: { name: string; number: number };
  /** `templates/vN`: this version's templates (a complete set; no fallthrough to earlier versions). */
  templatesDir: string;
  /** `transports/vN`, when a transports root is configured. It may not exist or may be empty; the router decides. */
  transportsDir?: string;
  /** Environment for the router's own settings and for its transports' config. */
  env: Record<string, string | undefined>;
  /** The engine's logger, already scoped to this version (every line carries `api_version`). Use it, not `console`. */
  logger: Logger;
}

/** What a version bundle's router module (`engine/routers/v<N>/router.ts`) exports as its default. */
export type VersionRouterFactory = (context: VersionContext) => Router | Promise<Router>;

export type VersionRouters = Readonly<Record<number, VersionRouterFactory>>;

/** Each API version is a bundle directory under `engine/routers/`. */
export const DEFAULT_ROUTERS_DIR = path.resolve(import.meta.dirname, "./routers");

/** A version bundle is a directory named `v<N>`. */
const VERSION_BUNDLE = /^v([1-9]\d*)$/;

/** The bundle's router module: TypeScript in development, compiled JS in production. */
const ROUTER_FILES = ["router.ts", "router.js"];

/**
 * Discovers the API version implementations in `routersDir`: each `v<N>/` bundle's `router` module must
 * default-export a router factory. The rest of the bundle (envelope, sender, transport contract) is
 * that version's own business. Returns an empty set if the directory is absent.
 */
export async function loadVersionRouters(routersDir: string = DEFAULT_ROUTERS_DIR): Promise<VersionRouters> {
  if (!(await stat(routersDir).catch(() => undefined))?.isDirectory()) return {};

  const routers: Record<number, VersionRouterFactory> = {};
  for (const entry of (await readdir(routersDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const match = entry.isDirectory() ? VERSION_BUNDLE.exec(entry.name) : null;
    if (!match) continue;

    const bundle = path.join(routersDir, entry.name);
    const present = new Set(await readdir(bundle));
    const file = ROUTER_FILES.find((f) => present.has(f));
    if (!file) throw new Error(`Router bundle ${entry.name} in ${routersDir} has no router.ts or router.js`);

    const mod = (await import(pathToFileURL(path.join(bundle, file)).href)) as { default?: unknown };
    if (typeof mod.default !== "function") {
      throw new Error(`Router implementation ${entry.name}/${file} must default-export a function (context) => Router`);
    }
    routers[Number(match[1])] = mod.default as VersionRouterFactory;
  }
  return routers;
}
