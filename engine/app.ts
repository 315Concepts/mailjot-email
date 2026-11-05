import path from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import { createLogger, type Logger } from "./logger.js";
import { requestLog } from "./requestLog.js";
import { loadVersionRouters, type VersionRouters } from "./router.js";
import { discoverVersions } from "./versions.js";

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

const notFound = { error: { code: "not_found", message: "Route not found" } };

/**
 * Builds the app from the version directories under `templatesRoot`: each `v<N>` directory is
 * served at `/v<N>` by that version's router bundle (`engine/routers/v<N>/router.ts`).
 * Throws StartupError if no versions exist or a version directory has no implementation.
 */
export interface AppOptions {
  /** Router implementations by version. Defaults to those discovered in `engine/routers`. */
  routers?: VersionRouters;
  /** Root of the transports directory (containing `v<N>` directories). Without it, no sender routes exist. */
  transportsRoot?: string;
  /** Environment transports read their config from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Where the engine and its routers log. Defaults to a logger on stdout configured from `env` (`LOG_LEVEL`). */
  logger?: Logger;
  /** Makes a request ID when the caller sends none. Defaults to a random UUID; tests inject a predictable one. */
  generateRequestId?: () => string;
}

export async function createApp(templatesRoot: string, options: AppOptions = {}): Promise<Express> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createLogger({ env });
  const implementations = options.routers ?? (await loadVersionRouters());
  const versions = await discoverVersions(templatesRoot, logger);
  if (versions.length === 0) {
    throw new StartupError(
      `No version directories (v1, v2, ...) found in ${templatesRoot}. Templates belong in a version directory such as ${templatesRoot}/v1.`,
    );
  }
  const unimplemented = versions.filter((v) => !implementations[v.number]);
  if (unimplemented.length > 0) {
    throw new StartupError(
      `Versioned templates ${unimplemented.map((v) => `"${v.name}"`).join(", ")} in ${templatesRoot} have no router implementation (engine/routers/v<N>/router.ts). Implemented versions: ${Object.keys(implementations).map((n) => `v${n}`).join(", ") || "none"}.`,
    );
  }

  const app = express();
  app.disable("x-powered-by");

  // First, so that every response (a 404 included) has a request ID and every request has an access line.
  app.use(requestLog({ logger, generateId: options.generateRequestId }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/", (_req, res) => {
    res.json({ versions: versions.map((v) => v.name) });
  });

  for (const version of versions) {
    const createRouter = implementations[version.number]!;
    const mount = `/${version.name}`;
    app.use(
      mount,
      // From here on, this request's lines say which version served it, and its access line gets the full route.
      (req, res, next) => {
        req.log = req.log.child({ api_version: version.name });
        res.locals.mount = mount;
        next();
      },
      await createRouter({
        version: { name: version.name, number: version.number },
        templatesDir: version.dir,
        transportsDir: options.transportsRoot ? path.join(options.transportsRoot, version.name) : undefined,
        env,
        logger: logger.child({ api_version: version.name }),
      }),
    );
  }

  app.use((_req, res) => {
    res.status(404).json(notFound);
  });

  const onError: ErrorRequestHandler = (err: unknown, req, res, _next) => {
    req.log.error({ event: "mailjot.error.unhandled", err }, "Unhandled error");
    res.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
  };
  app.use(onError);

  return app;
}
