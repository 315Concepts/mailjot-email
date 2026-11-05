import { describe, expect, it } from "vitest";
import type { TemplateModule } from "../../../../engine/template.js";
import { renderTemplate } from "../../../../engine/render.js";
import * as receipt from "./index.js";

const template = receipt as unknown as TemplateModule;
const input = receipt.examples.default!;

/** Pulls the inner HTML of every element matching `tag` out of an HTML string. */
const all = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!);

describe("billing/receipt", () => {
  it("has a dynamic subject", async () => {
    expect((await renderTemplate(template, input)).subject).toBe("Your receipt for order ORD-1001");
    expect(receipt.subject({ ...input, orderNumber: "ORD-9" })).toBe("Your receipt for order ORD-9");
  });

  it("puts the order number on its own line after the intro", async () => {
    const { text, html } = await renderTemplate(template, input);

    const lines = text.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]).toMatch(/^Hi Alice, .*receipt\.$/);
    expect(lines[1]).toBe("Order number: ORD-1001");

    const paragraphs = all(html, "p");
    expect(paragraphs[0]).toMatch(/^Hi Alice,/);
    expect(paragraphs[1]).toBe("Order number: ORD-1001");
  });

  it("lists charges in a table with a header and one row per charge", async () => {
    const { html, text } = await renderTemplate(template, input);

    // The charge table is the only one marked for plaintext data-table output; the others are layout.
    const table = /<table data-text-format="dataTable"[^>]*>([\s\S]*?)<\/table>/.exec(html)![1]!;
    expect(all(table, "th")).toEqual(["Description", "Qty", "Unit price", "Amount"]);
    const rows = all(all(table, "tbody")[0]!, "tr").map((r) => all(r, "td"));
    expect(rows).toEqual([
      ["Pro plan (monthly)", "1", "$19.00", "$19.00"],
      ["Extra seat", "3", "$5.00", "$15.00"],
    ]);

    // The plaintext alternative keeps the columns aligned rather than running cells together.
    expect(text).toMatch(/^Pro plan \(monthly\)\s+1\s+\$19\.00\s+\$19\.00$/m);
    expect(text).toMatch(/^Extra seat\s+3\s+\$5\.00\s+\$15\.00$/m);
  });

  it("shows the total in bold, computed from the charges", async () => {
    const { html, text } = await renderTemplate(template, input);
    expect(all(html, "strong")).toEqual(["Total: $34.00"]);
    expect(text).toContain("Total: $34.00");
  });

  it("formats other currencies", async () => {
    const { html } = await renderTemplate(template, receipt.examples.single);
    expect(all(html, "strong")).toEqual(["Total: €49.00"]);
  });

  it.each([
    ["no charges", { ...input, charges: [] }],
    ["a negative price", { ...input, charges: [{ description: "x", quantity: 1, unitPriceCents: -1 }] }],
    ["a fractional quantity", { ...input, charges: [{ description: "x", quantity: 1.5, unitPriceCents: 1 }] }],
    ["a bad order number", { ...input, orderNumber: "no spaces allowed" }],
    ["an unsupported currency", { ...input, currency: "XXX" }],
    ["an unknown property", { ...input, discount: 5 }],
  ])("rejects %s", async (_label, bad) => {
    await expect(renderTemplate(template, bad)).rejects.toMatchObject({ name: "ValidationError" });
  });
});
