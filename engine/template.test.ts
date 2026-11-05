import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TemplateContractError } from "./template.js";
import { discoverTemplates, TemplateNotFoundError, isSkippedDirectory, resolveTemplate } from "./discovery.js";
import { createTemplateLoader } from "./loader.js";

const realRoot = fileURLToPath(new URL("../templates/v1", import.meta.url));

describe("with the real templates directory", () => {
  it("discovers the sample template", async () => {
    const ids = (await discoverTemplates(realRoot)).map((d) => d.id);
    expect(ids).toContain("accounts/welcome");
  });

  it("loads and caches a valid template", async () => {
    const loader = createTemplateLoader(realRoot);
    const mod = await loader.load("accounts/welcome");
    expect(mod.metadata.id).toBe("accounts/welcome");
    expect(await loader.load("accounts/welcome")).toBe(mod);
  });
});

describe("path resolution", () => {
  it.each([
    "../package.json",
    "accounts/../accounts/welcome",
    "/etc/passwd",
    "accounts\\welcome",
    "accounts//welcome",
    "accounts/welcome/",
    "accounts/welcome\0",
    ".",
    "",
    "accounts/missing",
    "accounts",
  ])("rejects %j", async (requested) => {
    await expect(resolveTemplate(realRoot, requested)).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it("resolves a valid ID", async () => {
    const loc = await resolveTemplate(realRoot, "accounts/welcome");
    expect(loc.id).toBe("accounts/welcome");
  });
});

describe("with a scratch templates directory", () => {
  let tmp: string;
  let root: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "mailjot-docs-"));
    root = path.join(tmp, "templates");
    await mkdir(path.join(root, "bad/malformed"), { recursive: true });
    await writeFile(path.join(root, "bad/malformed/index.js"), "export const metadata = { id: 'wrong' };\n");
    await mkdir(path.join(tmp, "outside"), { recursive: true });
    await writeFile(path.join(tmp, "outside/index.js"), "export {};\n");
    await symlink(path.join(tmp, "outside"), path.join(root, "bad/escape"));
  });

  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("rejects a malformed template and lists every problem", async () => {
    const loader = createTemplateLoader(root);
    const err = await loader.load("bad/malformed").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateContractError);
    const problems = (err as TemplateContractError).problems.join("\n");
    expect(problems).toContain("schema");
    expect(problems).toContain("metadata.id");
    expect(problems).toContain("subject");
    expect(problems).toContain("default");
    expect(problems).toContain("examples");
  });

  it("refuses a symlink that escapes the root", async () => {
    await expect(resolveTemplate(root, "bad/escape")).rejects.toBeInstanceOf(TemplateNotFoundError);
  });
});

describe("discovery skips directories that are not templates", () => {
  let root: string;

  // Each of these holds an `index.js`, so scanning it would register it as a template.
  const files = [
    "accounts/welcome/index.js", // a template
    "billing/receipt/index.js", // a template
    ".hidden/index.js", // dot-directory at the top
    "accounts/.drafts/old/index.js", // dot-directory below a group
    "node_modules/pkg/index.js", // dependencies at the top
    "accounts/node_modules/dep/index.js", // dependencies below a group
    ".git/hooks/index.js", // tooling directories are dot-directories too
  ];

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mailjot-skip-"));
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "export {};");
    }
    // Plain files are never templates either, even ones named like directories we skip.
    await writeFile(path.join(root, "notes.txt"), "not a template");
    await writeFile(path.join(root, "accounts", "readme.md"), "not a template");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("lists only the real templates", async () => {
    expect((await discoverTemplates(root)).map((d) => d.id)).toEqual(["accounts/welcome", "billing/receipt"]);
  });

  it("refuses to resolve a requested path through any of them, so a request reaches only what is listed", async () => {
    const listed = (await discoverTemplates(root)).map((d) => d.id);
    // Every directory in the tree that holds an index.js, as a request path.
    const requestable = [...new Set(files.map((f) => path.dirname(f)))];

    for (const id of requestable) {
      if (listed.includes(id)) {
        await expect(resolveTemplate(root, id), id).resolves.toMatchObject({ id });
      } else {
        await expect(resolveTemplate(root, id), id).rejects.toBeInstanceOf(TemplateNotFoundError);
      }
    }
  });

  it("applies the rule to every segment of a requested path, whatever the letter case", async () => {
    for (const requested of ["node_modules", "node_modules/pkg", "accounts/node_modules/dep", "Node_Modules/pkg", "NODE_MODULES/pkg", "accounts/NODE_modules/dep"]) {
      await expect(resolveTemplate(root, requested), requested).rejects.toBeInstanceOf(TemplateNotFoundError);
    }
  });

  it("does not descend into a template directory, so nothing nested inside one is a second template", async () => {
    await mkdir(path.join(root, "billing", "receipt", "nested"), { recursive: true });
    await writeFile(path.join(root, "billing", "receipt", "nested", "index.js"), "export {};");
    expect((await discoverTemplates(root)).map((d) => d.id)).toEqual(["accounts/welcome", "billing/receipt"]);
  });
});

describe("isSkippedDirectory", () => {
  it.each([".git", ".hidden", ".", "..", "node_modules", "Node_Modules", "NODE_MODULES"])("skips %s", (name) => {
    expect(isSkippedDirectory(name)).toBe(true);
  });

  it.each(["accounts", "welcome", "node-modules", "node_modules2", "my_node_modules", "modules", "nodemodules"])("does not skip %s", (name) => {
    expect(isSkippedDirectory(name)).toBe(false);
  });
});
