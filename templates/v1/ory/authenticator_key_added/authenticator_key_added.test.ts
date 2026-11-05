import { describe, expect, it } from "vitest";
import type { TemplateModule } from "../../../../engine/template.js";
import { renderTemplate } from "../../../../engine/render.js";
import * as template from "./index.js";

const input = template.examples.default!;

describe("ory/authenticator_key_added", () => {
  it("centres the text with inline styles, in px", async () => {
    const { html } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).toContain("text-align:center");
    const style = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    expect(style).not.toMatch(/\d(rem|em)\b/);
  });

  it("states when the key was added and tells the reader to contact support", async () => {
    const { html, text } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).toContain(input.addedAt);
    expect(text).toContain(input.addedAt);
    expect(text).toContain("contact support");
  });

  it("has the Ory subject", async () => {
    const { subject } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(subject).toBe("A Security Key Was Added");
  });
});
