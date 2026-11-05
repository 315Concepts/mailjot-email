import { pathToFileURL } from "node:url";
import { assertTemplateModule, type TemplateModule } from "./template.js";
import { discoverTemplates, resolveTemplate, type TemplateLocation } from "./discovery.js";

export interface TemplateLoader {
  list(): Promise<TemplateLocation[]>;
  load(requested: string): Promise<TemplateModule>;
}

export interface LoaderOptions {
  /** If set, each template's `metadata.version` must have this major number (the version directory's). */
  majorVersion?: number;
}

/** Loads templates on demand from `root`, validating each against the contract and caching the result. */
export function createTemplateLoader(root: string, options: LoaderOptions = {}): TemplateLoader {
  const cache = new Map<string, Promise<TemplateModule>>();

  async function importTemplate({ id, entryPath }: TemplateLocation): Promise<TemplateModule> {
    const mod = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
    return assertTemplateModule(id, mod, options.majorVersion);
  }

  return {
    list: () => discoverTemplates(root),

    async load(requested) {
      const location = await resolveTemplate(root, requested);
      let pending = cache.get(location.id);
      if (!pending) {
        pending = importTemplate(location);
        cache.set(location.id, pending);
        // Our own cache forgets a failed load, but Node's module cache does not, so fixing the file only helps
        // after a syntax error (the module never compiled). A template that imported and then failed the contract,
        // or threw while importing, stays cached as it was until the process restarts.
        pending.catch(() => cache.delete(location.id));
      }
      return pending;
    },
  };
}
