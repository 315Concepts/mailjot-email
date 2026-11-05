/** Patterns that indicate a template expression or value was never resolved. */
const UNRESOLVED: { name: string; pattern: RegExp }[] = [
  { name: "{{ }} expression", pattern: /\{\{[\s\S]*?\}\}/ },
  { name: "${ } expression", pattern: /\$\{[\s\S]*?\}/ },
  { name: "<% %> expression", pattern: /<%[\s\S]*?%>/ },
  { name: "undefined", pattern: /\bundefined\b/ },
  { name: "[object Object]", pattern: /\[object Object\]/ },
  { name: "NaN", pattern: /\bNaN\b/ },
];

export interface RenderedOutput {
  subject: string;
  html: string;
  text: string;
}

/** Returns a list of integrity problems; empty means the output is acceptable. */
export function checkIntegrity({ subject, html, text }: RenderedOutput): string[] {
  const problems: string[] = [];

  if (subject.trim() === "") problems.push("subject is empty");
  if (/[\r\n]/.test(subject)) problems.push("subject contains a line break");
  if (html.trim() === "") problems.push("html is empty");
  if (text.trim() === "") problems.push("text is empty");

  const outputs = { subject, html, text };
  for (const [field, value] of Object.entries(outputs)) {
    for (const { name, pattern } of UNRESOLVED) {
      if (pattern.test(value)) problems.push(`${field} contains unresolved ${name}`);
    }
  }
  return problems;
}
