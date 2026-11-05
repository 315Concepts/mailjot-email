import path from "node:path";
import { access, constants, readdir } from "node:fs/promises";
import { createApp, StartupError } from "./app.js";
import { createLogger } from "./logger.js";

const templatesDir = path.resolve(process.env.TEMPLATES_DIR ?? "templates");
const transportsDir = path.resolve(process.env.TRANSPORTS_DIR ?? "transports");
const port = Number(process.env.PORT ?? 3000);

// First, so that even a startup failure is a structured line. It writes synchronously, so it is out before `process.exit`.
const logger = createLogger({ env: process.env });

// Fail fast with a clear message rather than serving 500s for every request.
try {
  await access(templatesDir, constants.R_OK | constants.X_OK);
  await readdir(templatesDir);
} catch {
  logger.fatal(
    { event: "mailjot.startup.failed", reason: "templates_dir_unreadable", templates_dir: templatesDir },
    `TEMPLATES_DIR "${templatesDir}" is missing or not readable. Set TEMPLATES_DIR to a compiled templates directory.`,
  );
  process.exit(1);
}

let app;
try {
  app = await createApp(templatesDir, { transportsRoot: transportsDir, logger });
} catch (err) {
  // A StartupError is a configuration message for the operator; anything else is unexpected and keeps its stack.
  if (err instanceof StartupError) logger.fatal({ event: "mailjot.startup.failed", reason: "invalid_layout" }, err.message);
  else logger.fatal({ event: "mailjot.startup.failed", err }, "Startup failed");
  process.exit(1);
}

const server = app.listen(port, () => {
  logger.info({ event: "mailjot.listening", port, templates_dir: templatesDir }, `mailjot listening on :${port}, templates from ${templatesDir}`);
});

// Slow-client protection (tightened from Node defaults for a small JSON API).
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
