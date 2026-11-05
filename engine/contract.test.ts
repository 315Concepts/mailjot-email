import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverTemplates } from "./discovery.js";
import { discoverVersions } from "./versions.js";
import type { TemplateModule } from "./template.js";
import { checkIntegrity } from "./integrity.js";
import { createTemplateLoader } from "./loader.js";
import { renderTemplate } from "./render.js";
import { transportContractV1 } from "./routers/v1/transport.js";
import { discoverTransports } from "./transport.js";

const realRoot = fileURLToPath(new URL("../templates", import.meta.url));
const fixturesRoot = fileURLToPath(new URL("../test/fixtures/templates", import.meta.url));

/** Every contract check for one template. Throws on the first violation. */
async function verifyContract(root: string, id: string, majorVersion: number): Promise<number> {
  // Loading asserts exports are present, metadata.id matches the directory, and the semver major
  // matches the version directory.
  const template: TemplateModule = await createTemplateLoader(root, { majorVersion }).load(id);
  expect(template.metadata.id).toBe(id);

  const examples = Object.entries(template.examples);
  expect(examples.length).toBeGreaterThan(0);
  for (const [name, input] of examples) {
    const parsed = template.schema.safeParse(input);
    expect(parsed.success, `example "${name}" must pass the schema`).toBe(true);

    const first = await renderTemplate(template, input);
    expect(first.html.trim(), `example "${name}" html`).not.toBe("");
    expect(first.text.trim(), `example "${name}" text`).not.toBe("");
    expect(checkIntegrity(first), `example "${name}" integrity`).toEqual([]);

    const second = await renderTemplate(template, structuredClone(input));
    expect(second, `example "${name}" must render deterministically`).toEqual(first);
  }
  return examples.length;
}

// Discovered dynamically: a new version or template directory is covered automatically.
const versions = await discoverVersions(realRoot);
const templates = (
  await Promise.all(
    versions.map(async (v) =>
      (await discoverTemplates(v.dir)).map((d) => ({ label: `${v.name}/${d.id}`, id: d.id, dir: v.dir, major: v.number })),
    ),
  )
).flat();

describe("template contract (all discovered templates, all versions)", () => {
  it("discovers at least one template", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it("does not include the test fixtures", () => {
    expect(templates.map((d) => d.id)).not.toContain("accounts/broken");
  });

  it.each(templates.map((d) => [d.label, d] as const))("%s satisfies the contract", async (_label, d) => {
    await verifyContract(d.dir, d.id, d.major);
  });
});

describe("contract check itself", () => {
  it("fails on a deliberately broken template", async () => {
    const [v1] = await discoverVersions(fixturesRoot);
    const ids = (await discoverTemplates(v1!.dir)).map((d) => d.id);
    expect(ids).toContain("accounts/broken");
    await expect(verifyContract(v1!.dir, "accounts/broken", 1)).rejects.toThrow();
  });

  it("fails when a template's semver major does not match its version directory", async () => {
    await expect(verifyContract(templates[0]!.dir, templates[0]!.id, 2)).rejects.toThrow(/major version 2/);
  });
});

// ---------------------------------------------------------------------------------------------
// Transports: every real transport in every version must satisfy the contract.
// ---------------------------------------------------------------------------------------------

const transportsRoot = fileURLToPath(new URL("../transports", import.meta.url));
const fixtureTransportsRoot = fileURLToPath(new URL("../test/fixtures/transports", import.meta.url));

/** Every contract check for one transport module, without needing real credentials. */
async function verifyTransportContract(entryPath: string, name: string): Promise<void> {
  const mod = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;

  // Exports present, metadata.id matches the directory name.
  const transport = transportContractV1.assert(name, mod);

  // The config schema must describe environment variables: parsing an empty environment must fail
  // cleanly (or succeed, if everything has a default), and every complaint must name an
  // UPPER_SNAKE_CASE variable so operators can act on it.
  const config = transport.config.safeParse({});
  if (!config.success) {
    for (const issue of config.error.issues) {
      expect(issue.path.length, `config issue "${issue.message}" must name a variable`).toBeGreaterThan(0);
      expect(String(issue.path[0]), "config variables are UPPER_SNAKE_CASE").toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  }

  // The sender treats a missing `options` as `{}`, so the options schema must accept that.
  expect(transport.options.safeParse({}).success, "options schema must accept an empty object").toBe(true);
}

const transportVersions = await discoverVersions(transportsRoot);
const transports = (
  await Promise.all(
    transportVersions.map(async (v) =>
      (await discoverTransports(v.dir)).map((t) => ({ label: `${v.name}/${t.name}`, ...t })),
    ),
  )
).flat();

describe("transport contract (all discovered transports, all versions)", () => {
  it("discovers at least the default transport", () => {
    expect(transports.map((t) => t.label)).toContain("v1/Mailjet");
  });

  it("does not include the test fixtures", () => {
    expect(transports.map((t) => t.name)).not.toContain("InMemory");
  });

  it.each(transports.map((t) => [t.label, t] as const))("%s satisfies the contract", async (_label, t) => {
    await verifyTransportContract(t.entryPath, t.name);
  });
});

describe("transport contract check itself", () => {
  const fixture = async (name: string) => {
    const [v1] = await discoverVersions(fixtureTransportsRoot);
    const found = (await discoverTransports(v1!.dir)).find((t) => t.name === name)!;
    return found;
  };

  it("passes a well-formed fixture", async () => {
    const t = await fixture("InMemory");
    await expect(verifyTransportContract(t.entryPath, t.name)).resolves.toBeUndefined();
  });

  it("fails a fixture that violates the contract", async () => {
    const t = await fixture("Broken");
    await expect(verifyTransportContract(t.entryPath, t.name)).rejects.toThrow(/violates the contract/);
  });

  it("fails an options schema that rejects an empty object", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mailjot-contract-"));
    try {
      await mkdir(path.join(dir, "Strict"));
      const entry = path.join(dir, "Strict", "transport.mjs");
      // A real transport would import zod; resolve it from the repository.
      const zod = pathToFileURL(fileURLToPath(import.meta.resolve("zod"))).href;
      await writeFile(
        entry,
        `import { z } from ${JSON.stringify(zod)};
         export const metadata = { id: "Strict", description: "options require a field" };
         export const config = z.object({});
         export const options = z.strictObject({ required: z.string() });
         export default async () => ({ ok: true, response: {} });`,
      );
      await expect(verifyTransportContract(entry, "Strict")).rejects.toThrow(/options schema must accept an empty object/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
