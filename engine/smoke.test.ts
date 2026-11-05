import { render } from "react-email";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import Welcome, { examples, schema } from "../templates/v1/accounts/welcome/index.js";

describe("workspace smoke test", () => {
  it("renders the sample template", async () => {
    const input = schema.parse(examples.default);
    const html = await render(createElement(Welcome, input));
    expect(html).toContain("Welcome aboard, Alice!");
  });
});
