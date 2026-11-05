import { useEffect, useState, type CSSProperties } from "react";
import type { TemplateModule } from "../engine/template.js";
import { RenderError, ValidationError } from "../engine/errors.js";
import { renderTemplate, type RenderResult } from "../engine/render.js";
import { describeSchema } from "../engine/schema.js";
import { formatIssues, type FieldError } from "../engine/validation.js";

type State =
  | { status: "loading" }
  | { status: "ok"; result: RenderResult }
  | { status: "invalid"; errors: FieldError[] }
  | { status: "failed"; code: string; detail?: string };

type Tab = "html" | "text" | "schema";

const styles: Record<string, CSSProperties> = {
  root: { fontFamily: "system-ui, sans-serif", fontSize: 14, padding: 16 },
  bar: { display: "flex", gap: 8, alignItems: "center", marginBottom: 12 },
  tab: { padding: "4px 12px", border: "1px solid #bbb", background: "#fff", cursor: "pointer", borderRadius: 4 },
  tabActive: { background: "#222", color: "#fff", borderColor: "#222" },
  pre: { background: "#f5f5f5", padding: 12, borderRadius: 4, overflow: "auto", whiteSpace: "pre-wrap" },
  frame: { width: "100%", height: 600, border: "1px solid #ddd", background: "#fff" },
  badge: { padding: "2px 8px", borderRadius: 10, color: "#fff", fontSize: 12 },
};

/** Builds a template into a document through the engine's own pipeline, so the preview shows the real email artifact. */
export function TemplatePreview({ template, input, onReroll }: { template: TemplateModule; input: unknown; onReroll?: () => void }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("html");

  useEffect(() => {
    let current = true;
    renderTemplate(template, input).then(
      (result) => current && setState({ status: "ok", result }),
      (err: unknown) => {
        if (!current) return;
        if (err instanceof ValidationError) setState({ status: "invalid", errors: formatIssues(err.issues) });
        else if (err instanceof RenderError) setState({ status: "failed", code: err.code, detail: err.detail ?? String(err.cause) });
        else setState({ status: "failed", code: "unexpected", detail: String(err) });
      },
    );
    return () => {
      current = false;
    };
  }, [template, input]);

  const valid = state.status === "ok";
  return (
    <div style={styles.root}>
      <div style={styles.bar}>
        <span style={{ ...styles.badge, background: valid ? "#2e7d32" : state.status === "loading" ? "#777" : "#c62828" }}>
          {valid ? "valid" : state.status === "loading" ? "rendering" : state.status === "invalid" ? "invalid input" : "render failed"}
        </span>
        {valid && <strong>{state.result.subject}</strong>}
        {onReroll && <button onClick={onReroll}>Regenerate</button>}
      </div>

      {state.status === "invalid" && (
        <ul>
          {state.errors.map((e, i) => (
            <li key={i}>
              <code>{e.path.join(".") || "(root)"}</code> — {e.message} <small>({e.code})</small>
            </li>
          ))}
        </ul>
      )}
      {state.status === "failed" && (
        <pre style={styles.pre}>
          {state.code}: {state.detail}
        </pre>
      )}

      {valid && (
        <>
          <div style={styles.bar}>
            {(["html", "text", "schema"] as const).map((t) => (
              <button key={t} style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }} onClick={() => setTab(t)}>
                {t === "html" ? "HTML" : t === "text" ? "Plaintext" : "Schema"}
              </button>
            ))}
          </div>
          {tab === "html" && <iframe title="HTML preview" style={styles.frame} srcDoc={state.result.html} />}
          {tab === "text" && <pre style={styles.pre}>{state.result.text}</pre>}
          {tab === "schema" && <pre style={styles.pre}>{JSON.stringify(describeSchema(template), null, 2)}</pre>}
        </>
      )}
    </div>
  );
}
