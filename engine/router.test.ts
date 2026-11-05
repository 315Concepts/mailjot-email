import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_ROUTERS_DIR, loadVersionRouters } from "./router.js";

describe("loadVersionRouters", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "mailjot-routers-"));
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  const make = async (name: string, files: Record<string, string>) => {
    const root = path.join(tmp, name);
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    return root;
  };

  it("finds the real v1 implementation by default", async () => {
    expect(DEFAULT_ROUTERS_DIR.endsWith(`${path.sep}routers`)).toBe(true);
    const routers = await loadVersionRouters();
    expect(Object.keys(routers)).toEqual(["1"]);
    expect(typeof routers[1]).toBe("function");
  });

  it("returns nothing when the routers directory does not exist", async () => {
    expect(await loadVersionRouters(path.join(tmp, "missing"))).toEqual({});
  });

  it("loads the router module from every v<N>/ bundle, compiled JS included", async () => {
    const root = await make("ok", {
      "v1/router.js": "export default () => 'one';",
      "v3/router.js": "export default () => 'three';",
      // The rest of a bundle is the version's own business and is never imported by discovery.
      "v1/envelope.js": "throw new Error('must not be imported');",
      "v1/sender.js": "throw new Error('must not be imported');",
      "v1/transport.js": "throw new Error('must not be imported');",
      // Not bundles.
      "v2.js": "throw new Error('must not be imported');",
      "notes/router.js": "throw new Error('must not be imported');",
      "v01/router.js": "throw new Error('must not be imported');",
      "vx/router.js": "throw new Error('must not be imported');",
    });
    const routers = await loadVersionRouters(root);
    expect(Object.keys(routers)).toEqual(["1", "3"]);
    expect((routers[1] as unknown as () => string)()).toBe("one");
  });

  it("prefers router.ts over compiled router.js when both exist", async () => {
    const root = await make("both", {
      "v1/router.ts": "export default () => 'source';",
      "v1/router.js": "export default () => 'compiled';",
    });
    expect(((await loadVersionRouters(root))[1] as unknown as () => string)()).toBe("source");
  });

  it("rejects a bundle without a router module", async () => {
    const root = await make("norouter", { "v1/envelope.js": "export {};" });
    await expect(loadVersionRouters(root)).rejects.toThrow(/bundle v1.*no router\.ts or router\.js/);
  });

  it("rejects a router module without a default-exported function", async () => {
    const root = await make("nodefault", { "v1/router.js": "export const x = 1;" });
    await expect(loadVersionRouters(root)).rejects.toThrow(/v1\/router\.js.*default-export a function/);
  });
});
