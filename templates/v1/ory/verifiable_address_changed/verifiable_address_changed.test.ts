import { describe, expect, it } from "vitest";
import type { TemplateModule } from "../../../../engine/template.js";
import { renderTemplate } from "../../../../engine/render.js";
import * as template from "./index.js";

const input = template.examples.default!;

describe("ory/verifiable_address_changed", () => {
  it("turns the Tailwind classes into inline styles, in px", async () => {
    const { html } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).toContain("text-align:center");
    const style = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    expect(style).toContain("max-width:576px");
    expect(style).not.toMatch(/\d(rem|em)\b/);
  });

  it("states when the address changed and tells the reader to contact support", async () => {
    const { html, text } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).toContain(input.changedAt);
    expect(text).toContain(input.changedAt);
    expect(text).toContain("contact support");
  });

  it("has the Ory subject", async () => {
    const { subject } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(subject).toBe("Your Email Address Was Changed");
  });
});
