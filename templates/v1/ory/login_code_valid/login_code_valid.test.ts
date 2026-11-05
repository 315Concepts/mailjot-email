import { describe, expect, it } from "vitest";
import type { TemplateModule } from "../../../../engine/template.js";
import { renderTemplate } from "../../../../engine/render.js";
import * as template from "./index.js";

const input = template.examples.default!;

describe("ory/login_code_valid", () => {
  it("turns the Tailwind classes into inline styles, in px", async () => {
    const { html } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).toContain("color:rgb(37,99,235)");
    expect(html).toContain("text-align:center");
    const style = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    expect(style).not.toMatch(/\d(rem|em)\b/);
  });

  it("labels the code, and has no link", async () => {
    const { html, text } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html.indexOf("Login code")).toBeLessThan(html.indexOf(input.loginCode));
    expect(html).not.toContain("href=");
    expect(text).toContain(input.loginCode);
    expect(text).toContain(`expires in ${input.expiresInMinutes} minutes`);
  });

  it("has the login subject", async () => {
    const { subject } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(subject).toBe("Your Login Code");
  });
});
