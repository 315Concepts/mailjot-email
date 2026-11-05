import { describe, expect, it } from "vitest";
import type { TemplateModule } from "../../../../engine/template.js";
import { renderTemplate } from "../../../../engine/render.js";
import * as template from "./index.js";

const input = template.examples.default!;

describe("ory/recovery_code_valid", () => {
  it("turns the Tailwind classes into inline styles, in px", async () => {
    const { html } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).toContain("color:rgb(37,99,235)");
    expect(html).toContain("text-align:center");
    const style = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    expect(style).not.toMatch(/\d(rem|em)\b/);
  });

  it("shows the code and the expiry, with no link or button", async () => {
    const { html, text } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(text).toContain(input.recoveryCode);
    expect(html).toContain("expires in 60 minutes");
    expect(html).not.toContain("<a ");
  });

  it("labels the code above it, and has the Ory subject", async () => {
    const { html, subject } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html.indexOf("Recovery code")).toBeLessThan(html.indexOf(input.recoveryCode));
    expect(subject).toBe("Recover Your Account");
  });
});
