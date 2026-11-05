import { describe, expect, it } from "vitest";
import type { TemplateModule } from "../../../../engine/template.js";
import { renderTemplate } from "../../../../engine/render.js";
import * as template from "./index.js";

const input = template.examples.default!;

describe("ory/recovery_invalid", () => {
  it("centres the text with inline styles, in px", async () => {
    const { html } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).toContain("text-align:center");
    expect(html).toContain("max-width:576px");
    const style = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    expect(style).not.toMatch(/\d(rem|em)\b/);
  });

  it("says no account exists, has no link, and has the subject", async () => {
    const { html, text, subject } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(text).toContain("unable to find an account");
    expect(html).not.toContain("href=");
    expect(subject).toBe("Account Recovery Attempt");
  });

  it("accepts only an empty input", () => {
    expect(template.schema.safeParse({}).success).toBe(true);
    expect(template.schema.safeParse({ extra: "x" }).success).toBe(false);
  });
});
