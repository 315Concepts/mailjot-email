import { createElement, type ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as welcome from "../templates/v1/accounts/welcome/index.js";
import type { TemplateModule } from "./template.js";
import { RenderError, ValidationError } from "./errors.js";
import { DEFAULT_RENDER_TIMEOUT_MS, parseRenderTimeout, renderTemplate } from "./render.js";

const schema = z.strictObject({ name: z.string() });

/** Builds a synthetic template so each failure mode can be triggered in isolation. */
function makeTemplate(overrides: Record<string, unknown> = {}): TemplateModule {
  const Component: ComponentType<{ name: string }> = ({ name }) => createElement("p", null, `Hello ${name}`);
  return {
    schema,
    metadata: { id: "test/template", version: "2.0.0", description: "test" },
    subject: (i: { name: string }) => `Hi ${i.name}`,
    default: Component,
    examples: { default: { name: "Alice" } },
    ...overrides,
  } as unknown as TemplateModule;
}

const valid = { name: "Alice" };

describe("renderTemplate", () => {
  it("renders the sample template", async () => {
    const result = await renderTemplate(welcome as unknown as TemplateModule, welcome.examples.default);
    expect(result).toMatchObject({
      template: "accounts/welcome",
      version: "1.0.0",
      subject: "Welcome aboard, Alice!",
    });
    expect(result.html).toContain("<!DOCTYPE html");
    expect(result.html).toContain("Welcome aboard, Alice!");
    expect(result.text).toContain("Welcome aboard, Alice!");
    expect(result.text).not.toContain("<");
  });

  it("supports a static subject", async () => {
    const result = await renderTemplate(makeTemplate({ subject: "Static" }), valid);
    expect(result.subject).toBe("Static");
  });

  it("is deterministic", async () => {
    const template = makeTemplate();
    expect(await renderTemplate(template, valid)).toEqual(await renderTemplate(template, valid));
  });

  it("rejects invalid input before rendering", async () => {
    let rendered = false;
    const template = makeTemplate({
      default: (() => {
        rendered = true;
        return null;
      }),
    });
    await expect(renderTemplate(template, { name: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(renderTemplate(template, { ...valid, extra: true })).rejects.toBeInstanceOf(ValidationError);
    expect(rendered).toBe(false);
  });

  describe("failures", () => {
    const expectRenderError = async (template: TemplateModule, code: string, detail?: string) => {
      const err = await renderTemplate(template, valid).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RenderError);
      expect((err as RenderError).code).toBe(code);
      if (detail) expect((err as RenderError).detail).toContain(detail);
      return err as RenderError;
    };

    it("component throws", async () => {
      const template = makeTemplate({
        default: (() => {
          throw new Error("secret internal path /srv/app");
        }),
      });
      const err = await expectRenderError(template, "render_failed");
      expect(err.message).not.toContain("secret");
      expect(err.cause).toBeInstanceOf(Error);
    });

    it("subject function throws", async () => {
      await expectRenderError(
        makeTemplate({
          subject: () => {
            throw new Error("boom");
          },
        }),
        "render_failed",
      );
    });

    it("subject is empty", async () => {
      await expectRenderError(makeTemplate({ subject: "   " }), "integrity_failed", "subject is empty");
    });

    it("subject has a line break", async () => {
      await expectRenderError(makeTemplate({ subject: "a\nBcc: x@y.z" }), "integrity_failed", "line break");
    });

    it("subject is not a string", async () => {
      await expectRenderError(
        makeTemplate({ subject: (() => undefined) }),
        "integrity_failed",
        "not a string",
      );
    });

    it("plaintext is empty", async () => {
      const Empty = () => createElement("div");
      await expectRenderError(
        makeTemplate({ default: Empty }),
        "integrity_failed",
        "text is empty",
      );
    });

    it.each([
      ["{{ name }}", "{{ }}"],
      ["${name}", "${ }"],
      ["<%= name %>", "<% %>"],
      ["undefined", "undefined"],
      ["[object Object]", "[object Object]"],
      ["NaN", "NaN"],
    ])("output contains %s", async (content, label) => {
      const Bad = () => createElement("p", null, `Hi ${content}`);
      await expectRenderError(
        makeTemplate({ default: Bad }),
        "integrity_failed",
        `unresolved ${label}`,
      );
    });

    it("subject contains an unresolved expression", async () => {
      await expectRenderError(makeTemplate({ subject: "Hi {{name}}" }), "integrity_failed", "subject contains unresolved");
    });
  });
});

describe("render timeout", () => {
  it("parses a timeout setting, ignoring anything that is not a positive number", () => {
    expect(parseRenderTimeout("2500")).toBe(2500);
    expect(parseRenderTimeout(" 30 ")).toBe(30);
    for (const bad of [undefined, "", "  ", "0", "-5", "abc", "NaN", "Infinity"]) {
      expect(parseRenderTimeout(bad), String(bad)).toBeUndefined();
    }
    expect(DEFAULT_RENDER_TIMEOUT_MS).toBe(10_000);
  });

  it("fails a render that outlives the timeout, as a render failure", async () => {
    const Slow = () => {
      throw new Promise(() => {}); // suspends forever
    };
    const template = makeTemplate({ default: Slow });
    const started = Date.now();
    const err = await renderTemplate(template, valid, { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as RenderError).code).toBe("render_failed");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not interfere with a render that finishes in time", async () => {
    await expect(renderTemplate(makeTemplate(), valid, { timeoutMs: 5_000 })).resolves.toMatchObject({ subject: "Hi Alice" });
  });
});
