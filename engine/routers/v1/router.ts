import express, { Router, type ErrorRequestHandler, type Request } from "express";
import { TemplateContractError } from "../../template.js";
import { TemplateNotFoundError } from "../../discovery.js";
import { RenderError, ValidationError } from "../../errors.js";
import { createTemplateLoader, type TemplateLoader } from "../../loader.js";
import { z } from "zod";
import { bearerAuth, tokenProblem } from "../../auth.js";
import { envelopeSchema } from "./envelope.js";
import { parseRenderTimeout, renderTemplate } from "../../render.js";
import { describeSchema, JSON_SCHEMA_VERSION } from "../../schema.js";
import { FlatRequestError, SendFailedError, sendTemplate } from "./sender.js";
import { createV1TransportLoader, type V1TransportLoader } from "./transport.js";
import { discoverTransports, TransportContractError, TransportNotFoundError, TransportUnavailableError } from "../../transport.js";
import { formatIssues } from "../../validation.js";
import type { Logger } from "../../logger.js";
import { annotate } from "../../requestLog.js";
import type { VersionContext } from "../../router.js";

interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

const fail = (code: string, message: string, details?: unknown): ApiError => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

/** Wildcard params arrive as an array of path segments in Express 5. */
const templatePath = (req: Request): string => {
  const param = req.params.template;
  return Array.isArray(param) ? param.join("/") : String(param);
};

const toJsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" });

async function listTemplates(loader: TemplateLoader, logger: Logger) {
  const templates = [];
  for (const { id } of await loader.list()) {
    try {
      const { metadata } = await loader.load(id);
      templates.push({ template: id, version: metadata.version, description: metadata.description });
    } catch (err) {
      // A broken template must not hide the healthy ones; it is logged and omitted.
      logger.warn(
        { event: "mailjot.template.unloadable", template: id, ...(err instanceof TemplateContractError ? { problems: err.problems } : {}), err },
        `Skipping unloadable template "${id}"`,
      );
    }
  }
  return templates;
}

/** Errors raised by Express body parsing carry a status and type. */
function isHttpError(err: unknown): err is { status: number; type?: string } {
  return typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number";
}

/**
 * Whether the transports directory currently holds at least one transport. Checked on every sender request
 * (one directory read), so a transport added while the server runs is picked up without a restart. A missing
 * directory, or one that cannot be scanned, counts as "none".
 */
async function hasTransports(dir: string): Promise<boolean> {
  return (await discoverTransports(dir).catch(() => [])).length > 0;
}

/** At startup, if transports are already present, logs whether sender authentication is on and which transports are usable. */
async function announceTransports(dir: string, loader: V1TransportLoader, env: VersionContext["env"], logger: Logger): Promise<void> {
  if (!(await hasTransports(dir))) return;

  const problem = tokenProblem(env.MAILJOT_TRANSPORT_AUTH_TOKEN);
  if (problem) {
    logger.warn(
      { event: "mailjot.sender.ready", auth: "disabled", reason: problem },
      "Sender authentication is DISABLED: all sender requests will be rejected",
    );
  } else {
    logger.info({ event: "mailjot.sender.ready", auth: "required" }, "Sender authentication: bearer token required");
  }
  for (const t of await loader.list()) {
    logger.info(
      { event: "mailjot.transport.status", transport: t.name, available: t.available, ...(t.available ? {} : { problems: t.problems }) },
      `Transport ${t.name} ${t.available ? "available" : "unavailable"}`,
    );
  }
}

/**
 * The v1 API, mounted at /v1. The default export is what the engine discovers. It resolves everything
 * for its own version from the directories the engine gives it: v1 templates, v1 transports and the v1
 * transport contract. Request and response shapes, including errors, are frozen once released.
 */
export async function createRouter({ version, templatesDir, transportsDir, env, logger }: VersionContext): Promise<Router> {
  const templates = createTemplateLoader(templatesDir, { majorVersion: version.number });
  // Building a loader reads nothing from disk; whether any transports exist is decided per request (see below).
  const transports = transportsDir ? createV1TransportLoader(transportsDir, { env }) : undefined;
  if (transports && transportsDir) await announceTransports(transportsDir, transports, env, logger);
  const senderToken = env.MAILJOT_TRANSPORT_AUTH_TOKEN;
  // Node-side configuration: the render path itself never reads the environment.
  const renderOptions = { timeoutMs: parseRenderTimeout(env.RENDER_TIMEOUT_MS) };
  const router = Router();
  /** This request's logger (it carries the request ID); the router's own logger if the engine did not provide one. */
  const log = (req: Request): Logger => req.log ?? logger;

  router.get("/templates", async (req, res) => {
    res.json({ templates: await listTemplates(templates, log(req)) });
  });

  router.get("/schemas/*template", async (req, res) => {
    const template = await templates.load(templatePath(req));
    annotate(res, { template: template.metadata.id });
    res.json(describeSchema(template));
  });

  router.post("/render/*template", express.json({ limit: "1mb" }), async (req, res) => {
    if (!req.is("application/json")) {
      res.status(415).json(fail("unsupported_media_type", "Content-Type must be application/json"));
      return;
    }
    const template = await templates.load(templatePath(req));
    annotate(res, { template: template.metadata.id });
    res.json(await renderTemplate(template, req.body, renderOptions));
  });

  // Delivery is opt-in. The sender routes are mounted whenever a transports directory is configured, but each
  // request first checks that the directory currently holds a transport. Without one they behave exactly as if
  // they did not exist (the same 404 as any unknown route, whatever credentials were sent), and a transport
  // added later is picked up without a restart. Editing a transport that has already loaded still needs one.
  if (transports && transportsDir) {
    const dir = transportsDir;
    router.use("/sender", async (_req, res, next) => {
      if (await hasTransports(dir)) {
        next();
        return;
      }
      res.status(404).json(fail("not_found", "Route not found"));
    });

    // Authenticate before anything else, so unauthenticated callers learn nothing (not even which transports exist).
    // bearerAuth either calls next() or sends the 401 itself, both synchronously, so a rejection can be logged here
    // without bearerAuth knowing about logging. The log records the route and whether a credential was presented at
    // all (a client sending none is a different problem from a wrong one), never the credential.
    const authenticate = bearerAuth(senderToken);
    router.use("/sender", (req, res, next) => {
      let accepted = false;
      authenticate(req, res, (...args) => {
        accepted = true;
        next(...args);
      });
      if (!accepted) {
        log(req).warn(
          { event: "mailjot.auth.rejected", route: "/sender", method: req.method, credential_presented: Boolean(req.headers.authorization) },
          "Sender authentication rejected",
        );
      }
    });

    router.get("/sender", async (req, res) => {
      const listed = [];
      for (const t of await transports.list()) {
        if (!t.available) {
          // Why it is unavailable (missing variables) is for operators, not callers.
          log(req).warn({ event: "mailjot.transport.unavailable", transport: t.name, problems: t.problems }, `Transport "${t.name}" is unavailable`);
          listed.push({ name: t.name, available: false });
          continue;
        }
        const loaded = await transports.load(t.name);
        listed.push({
          name: t.name,
          description: loaded.description,
          available: true,
          options: toJsonSchema(loaded.optionsSchema),
        });
      }
      res.json({ jsonSchemaVersion: JSON_SCHEMA_VERSION, envelope: toJsonSchema(envelopeSchema), transports: listed });
    });

    router.post("/sender/:transport/*template", express.json({ limit: "1mb" }), async (req, res) => {
      if (!req.is("application/json")) {
        res.status(415).json(fail("unsupported_media_type", "Content-Type must be application/json"));
        return;
      }
      const transport = await transports.load(String(req.params.transport));
      const template = await templates.load(templatePath(req));
      annotate(res, { transport: transport.name, template: template.metadata.id });
      const started = performance.now();
      const outcome = await sendTemplate(template, transport, req.body, renderOptions, log(req));
      log(req).info(
        {
          event: "mailjot.send.ok",
          transport: outcome.transport,
          template: outcome.template,
          ...(outcome.messageId === undefined ? {} : { message_id: outcome.messageId }),
          dry_run: outcome.dryRun === true,
          duration_ms: Math.round(performance.now() - started),
        },
        outcome.dryRun ? "Dry run completed, nothing sent" : "Message sent",
      );
      res.json(outcome);
    });
  }

  router.use((_req, res) => {
    res.status(404).json(fail("not_found", "Route not found"));
  });

  /** Internals of a failed build: the template, which layer failed, and the cause chain. Never the input or the output. */
  const logRenderFailure = (log: Logger, err: RenderError) =>
    log.error(
      { event: "mailjot.render.failed", template: err.templateId, code: err.code, ...(err.detail === undefined ? {} : { detail: err.detail }), err },
      `Render failure (${err.code}) for "${err.templateId}"`,
    );

  const onError: ErrorRequestHandler = (err: unknown, req, res, _next) => {
    const reqLog = log(req);
    if (err instanceof FlatRequestError) {
      // Only a failed build is for the operator; the other flat errors are mistakes by the caller.
      if (err.cause instanceof RenderError) logRenderFailure(reqLog, err.cause);
      res.status(400).json(err.body);
    } else if (err instanceof TemplateNotFoundError) {
      res.status(404).json(fail("template_not_found", "Template not found"));
    } else if (err instanceof TransportNotFoundError) {
      res.status(404).json(fail("transport_not_found", "Transport not found"));
    } else if (err instanceof TransportUnavailableError) {
      reqLog.error({ event: "mailjot.transport.unavailable", transport: err.transport, problems: err.problems }, err.message);
      res.status(503).json(fail("transport_unavailable", "Transport is unavailable"));
    } else if (err instanceof TransportContractError) {
      reqLog.error({ event: "mailjot.transport.contract_violation", transport: err.transport, problems: err.problems }, err.message);
      res.status(503).json(fail("transport_unavailable", "Transport is unavailable"));
    } else if (err instanceof SendFailedError) {
      // Neither the provider's `response` nor the transport's `message` is logged: both go to the caller, and a
      // provider error can echo a recipient address (an invalid-address rejection does). Request ID correlation can
      // find the rest.
      reqLog.error(
        { event: "mailjot.send.failed", transport: err.transport, template: err.template, reason: err.reason },
        `Send failed via "${err.transport}" for "${err.template}" (${err.reason})`,
      );
      res
        .status(502)
        .json(fail("send_failed", err.message, { transport: err.transport, template: err.template, reason: err.reason, response: err.response }));
    } else if (err instanceof ValidationError) {
      res.status(422).json(fail("validation_failed", "Input validation failed", formatIssues(err.issues)));
    } else if (err instanceof RenderError) {
      logRenderFailure(reqLog, err);
      res.status(500).json(fail(err.code, "Failed to render template"));
    } else if (err instanceof TemplateContractError) {
      reqLog.error({ event: "mailjot.template.contract_violation", template: err.templateId, problems: err.problems }, err.message);
      res.status(500).json(fail("template_unavailable", "Template is unavailable"));
    } else if (isHttpError(err) && err.status >= 400 && err.status < 500) {
      const code = err.type === "entity.too.large" ? "payload_too_large" : "bad_request";
      const message =
        err.type === "entity.parse.failed"
          ? "Request body is not valid JSON"
          : err.type === "entity.too.large"
            ? "Request body is too large"
            : "Bad request";
      res.status(err.status).json(fail(code, message));
    } else {
      reqLog.error({ event: "mailjot.error.unhandled", err }, "Unhandled error");
      res.status(500).json(fail("internal_error", "Internal server error"));
    }
  };
  router.use(onError);

  return router;
}

export default createRouter;
