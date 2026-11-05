import { describe, expect, it } from "vitest";
import type { TemplateModule } from "../../../../engine/template.js";
import { renderTemplate } from "../../../../engine/render.js";
import * as template from "./index.js";

const input = template.examples.default!;

describe("ory/verification_invalid", () => {
  it("renders centred text with px units only", async () => {
    const { html, text } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).toContain("text-align:center");
    expect(html).toContain("max-width:576px");
    const style = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    expect(style).not.toMatch(/\d(rem|em)\b/);
    expect(text).toContain("unable to find an account");
  });

  it("has no button and the Ory-style subject", async () => {
    const { html, subject } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).not.toContain("<a ");
    expect(subject).toBe("Account Verification Attempt");
  });
});
