import { describe, expect, it } from "vitest";
import type { TemplateModule } from "../../../../engine/template.js";
import { renderTemplate } from "../../../../engine/render.js";
import * as demo from "./index.js";

const template = demo as unknown as TemplateModule;
const input = demo.examples.default!;

describe("demos/tailwind", () => {
  it("turns utility classes into inline styles", async () => {
    const { html } = await renderTemplate(template, input);
    // bg-brand (#4f46e5) and text-white become rgb() values on the element, not classes the client must resolve.
    expect(html).toContain("background-color:rgb(79,70,229)");
    expect(html).toContain("color:rgb(255,255,255)");
  });

  it("emits the responsive utility as a media query", async () => {
    const { html } = await renderTemplate(template, input);
    expect(html).toMatch(/@media[^{]*\{[^}]*sm_px-10/);
  });

  it("keeps spacing, type sizes and radius in px, not rem", async () => {
    const { html } = await renderTemplate(template, input);
    const style = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
    expect(style).not.toMatch(/\d(rem|em)\b/);
  });

  it("includes the logo, and reads sensibly as plaintext", async () => {
    const { html, text } = await renderTemplate(template, input);
    expect(html).toContain('src="https://315concepts.com/favicon.ico"');
    expect(text).toContain("YOUR WORKSPACE IS READY"); // the plaintext conversion uppercases <h1>
    expect(text).toContain("Invite your team");
      });

  it("accepts an https logo and rejects other schemes", () => {
    expect(demo.schema.safeParse({ ...input, logoUrl: "https://example.com/logo.png" }).success).toBe(true);
    expect(demo.schema.safeParse({ ...input, logoUrl: "data:image/png;base64,AAAA" }).success).toBe(false);
    expect(demo.schema.safeParse({ ...input, logoUrl: "http://example.com/logo.png" }).success).toBe(false);
    expect(demo.schema.safeParse({ ...input, logoUrl: "javascript:alert(1)" }).success).toBe(false);
  });
});
