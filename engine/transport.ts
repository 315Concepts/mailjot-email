import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export class TransportNotFoundError extends Error {
  constructor(public readonly requested: string) {
    super(`Transport not found: ${requested}`);
    this.name = "TransportNotFoundError";
  }
}

/** The module does not satisfy the transport contract. */
export class TransportContractError extends Error {
  constructor(
    public readonly transport: string,
    public readonly problems: string[],
  ) {
    super(`Transport "${transport}" violates the contract: ${problems.join("; ")}`);
    this.name = "TransportContractError";
  }
}

/** The transport is valid but its environment configuration is missing or invalid. Maps to 503. */
export class TransportUnavailableError extends Error {
  constructor(
    public readonly transport: string,
    /** Environment variable names and what is wrong with them. For logs only, never for responses. */
    public readonly problems: string[],
  ) {
    super(`Transport "${transport}" is not configured`);
    this.name = "TransportUnavailableError";
  }
}

/**
 * A transport contract, as the engine sees it at runtime. Each API version owns one (the v1 contract
 * is in `routers/v1/transport.ts`), so this module knows nothing about any version's message or result shapes:
 * the router passes in the contract for its own version.
 */
export interface TransportContract<Message, Result> {
  /**
   * Checks a loaded module against this version of the contract and returns it in the normalised
   * form the loader needs. Throws TransportContractError listing every problem.
   */
  assert(name: string, mod: Record<string, unknown>): ContractedTransport<Message, Result>;
}

export interface ContractedTransport<Message, Result> {
  description: string;
  /** Zod schema over environment variables, parsed by the loader. */
  config: z.ZodType<unknown>;
  /** Schema for provider-specific options; "no options" if the transport declares none. */
  options: z.ZodType<Record<string, unknown>>;
  send(message: Message, config: unknown): Promise<Result>;
}

/** A transport that has been loaded, checked and configured. */
export interface LoadedTransport<Message = unknown, Result = unknown> {
  /** Canonical name: the directory name. */
  name: string;
  description: string;
  /** Schema for provider-specific options; "no options" if the transport declares none. */
  optionsSchema: z.ZodType<Record<string, unknown>>;
  send(message: Message): Promise<Result>;
}

export interface TransportInfo {
  name: string;
  description?: string;
  available: boolean;
  /** Why it is unavailable. For logs and operators; do not return to API callers. */
  problems?: string[];
}

export interface TransportLoader<Message = unknown, Result = unknown> {
  list(): Promise<TransportInfo[]>;
  load(requested: string): Promise<LoadedTransport<Message, Result>>;
}

/** Each transport is a directory `<Name>/` holding `transport.tsx` (development) or compiled `transport.js`. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENTRY_FILES = ["transport.tsx", "transport.ts", "transport.js"];

interface TransportFile {
  name: string;
  entryPath: string;
}

/**
 * Scans `root` (one version directory, e.g. `transports/v1`) for transport directories.
 * Other entries, such as stray files, are ignored. Names are unique ignoring case.
 */
export async function discoverTransports(root: string): Promise<TransportFile[]> {
  const files: TransportFile[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const present = new Set(await readdir(dir));
    const entryFile = ENTRY_FILES.find((f) => present.has(f));
    if (entryFile) files.push({ name: entry.name, entryPath: path.join(dir, entryFile) });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Map<string, string>();
  for (const { name } of files) {
    const clash = seen.get(name.toLowerCase());
    if (clash) throw new Error(`Transport names "${clash}" and "${name}" differ only in case; names are matched case-insensitively`);
    seen.set(name.toLowerCase(), name);
  }
  return files;
}

/** Maps a requested name to a transport, ignoring case. Unsafe, unknown or escaping names are "not found". */
export async function resolveTransport(root: string, requested: string): Promise<TransportFile> {
  if (!SAFE_NAME.test(requested)) throw new TransportNotFoundError(requested);
  const found = (await discoverTransports(root)).find((t) => t.name.toLowerCase() === requested.toLowerCase());
  if (!found) throw new TransportNotFoundError(requested);

  // Defend against symlinks that point outside the transports root.
  const [realRoot, realEntry] = await Promise.all([realpath(root), realpath(found.entryPath)]);
  if (!realEntry.startsWith(realRoot + path.sep)) throw new TransportNotFoundError(requested);
  return found;
}

export interface TransportLoaderOptions<Message, Result> {
  /** The contract version this loader enforces (supplied by the router for its API version). */
  contract: TransportContract<Message, Result>;
  /** Environment the `config` schemas are parsed from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Loads transports on demand from one version directory. A transport whose environment
 * configuration is missing or invalid is reported as unavailable, never as a crash.
 */
export function createTransportLoader<Message, Result>(
  root: string,
  options: TransportLoaderOptions<Message, Result>,
): TransportLoader<Message, Result> {
  const env = options.env ?? process.env;
  const cache = new Map<string, Promise<LoadedTransport<Message, Result>>>();

  async function importTransport({ name, entryPath }: TransportFile): Promise<LoadedTransport<Message, Result>> {
    const mod = options.contract.assert(name, (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>);

    const parsed = mod.config.safeParse(env);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`);
      throw new TransportUnavailableError(name, problems);
    }
    const config = parsed.data;

    return {
      name,
      description: mod.description,
      optionsSchema: mod.options,
      send: (message) => mod.send(message, config),
    };
  }

  return {
    async list() {
      const infos: TransportInfo[] = [];
      for (const file of await discoverTransports(root)) {
        try {
          const loaded = await this.load(file.name);
          infos.push({ name: file.name, description: loaded.description, available: true });
        } catch (err) {
          const problems =
            err instanceof TransportUnavailableError || err instanceof TransportContractError
              ? err.problems
              : [err instanceof Error ? err.message : String(err)];
          infos.push({ name: file.name, available: false, problems });
        }
      }
      return infos;
    },

    async load(requested) {
      const file = await resolveTransport(root, requested);
      let pending = cache.get(file.name);
      if (!pending) {
        pending = importTransport(file);
        cache.set(file.name, pending);
        // Our own cache forgets a failed load, so a fixed environment is picked up (config is parsed after the
        // import, every time). A fixed file is not, except after a syntax error: Node's module cache keeps a
        // module that imported and then failed the contract, or threw while importing, until the process restarts.
        pending.catch(() => cache.delete(file.name));
      }
      return pending;
    },
  };
}
