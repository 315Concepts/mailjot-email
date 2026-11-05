import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef } from "react";
import { useArgs } from "storybook/preview-api";
import type { TemplateModule } from "../engine/template.js";
import { TemplatePreview } from "./TemplatePreview.js";

const RANDOM = "random";

interface Args {
  scenario: string;
  input: unknown;
}

/**
 * Builds a template's Storybook meta and single "Preview" story.
 * Scenarios come from the template's `examples`; `random` (development only) adds a generated payload.
 * Editing the `input` control overrides the scenario, and invalid input shows validation feedback.
 *
 * Usage in `*.stories.tsx`:
 *   const { meta, Preview } = templateStories(template);
 *   export default meta;
 *   export { Preview };
 */
export function templateStories<T>(template: TemplateModule<T>, options: { random?: () => T } = {}) {
  const { random } = options;
  const names = Object.keys(template.examples);
  const scenarios = random ? [...names, RANDOM] : names;
  const pick = (scenario: string): unknown => (scenario === RANDOM && random ? random() : template.examples[scenario]);
  const initial = names.includes("default") ? "default" : names[0]!;

  const meta: Meta<Args> = {
    // Matches the title Storybook derives from the file path (emails/v<N>/<id>/...).
    title: `v${template.metadata.version.split(".")[0]}/${template.metadata.id}`,
    parameters: { docs: { description: { component: template.metadata.description } } },
    argTypes: {
      scenario: { control: "select", options: scenarios },
      input: { control: "object" },
    },
  };

  const Preview: StoryObj<Args> = {
    args: { scenario: initial, input: pick(initial) },
    render: function Render(args) {
      const [, updateArgs] = useArgs<Args>();
      const first = useRef(true);
      useEffect(() => {
        if (first.current) {
          first.current = false;
          return;
        }
        updateArgs({ input: pick(args.scenario) });
      }, [args.scenario]);
      return (
        <TemplatePreview
          template={template as TemplateModule}
          input={args.input}
          onReroll={args.scenario === RANDOM ? () => updateArgs({ input: pick(RANDOM) }) : undefined}
        />
      );
    },
  };

  return { meta, Preview };
}
