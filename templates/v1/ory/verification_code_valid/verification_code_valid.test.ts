import { describe, expect, it } from "vitest";
import type { TemplateModule } from "../../../../engine/template.js";
import { renderTemplate } from "../../../../engine/render.js";
import * as template from "./index.js";

const input = template.examples.default!;

describe("ory/verification_code_valid", () => {
  it("turns the Tailwind classes into inline styles, in px", async () => {
    const { html } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html).toContain("background-color:rgb(37,99,235)");
    expect(html).toContain("text-align:center");
    const style = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    expect(style).not.toMatch(/\d(rem|em)\b/);
  });

  it("shows the code above the link, and the link in the button", async () => {
    const { html, text } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html.indexOf(input.verificationCode)).toBeLessThan(html.indexOf("Or click the following link:"));
    expect(html).toContain(`href="${input.verificationUrl.replaceAll("&", "&amp;")}"`);
    expect(text).toContain(input.verificationCode);
  });

  it("colours the code in the brand blue", async () => {
    const { html } = await renderTemplate(template as unknown as TemplateModule, input);
    const codeTag = html.match(/<p[^>]*>\s*123456\s*<\/p>/)?.[0] ?? "";
    expect(codeTag).toContain("color:rgb(37,99,235)");
  });

  it("labels the code, and has the Ory subject", async () => {
    const { html, subject } = await renderTemplate(template as unknown as TemplateModule, input);
    expect(html.indexOf("Verification code")).toBeLessThan(html.indexOf(input.verificationCode));
    expect(subject).toBe("Verify Your Account");
  });
});
