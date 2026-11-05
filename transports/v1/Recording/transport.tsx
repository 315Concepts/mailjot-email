import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SendResult, TransportMessage, TransportModule } from "../../../engine/routers/v1/transport.js";

// Recording transport: delivers nothing. Each message is saved as a directory of files that you can
// open in a browser or diff:
//
//   <RECORDING_DIR>/<id>/message.json   who, what, which template and version
//   <RECORDING_DIR>/<id>/message.html   the HTML body, as rendered
//   <RECORDING_DIR>/<id>/message.txt    the plaintext body
//
// A message appears all at once (it is written to a temporary directory and renamed), so a reader never
// sees a half-written recording.

export const metadata = {
  id: "Recording",
  description: "Saves each message to a directory as JSON, HTML and plaintext files instead of sending it.",
};

export const config = z.object({
  /** Where recordings are written. Required, so nothing is written anywhere by accident. */
  RECORDING_DIR: z.string().min(1, "is required"),
});
type Config = z.output<typeof config>;

export const options = z.strictObject({
  /** A free-form tag stored in message.json, for finding the recording again. */
  tag: z.string().min(1).max(100).optional(),
});
type Options = z.output<typeof options>;

const FILES = ["message.json", "message.html", "message.txt"];

const send = async ({ template, version, subject, html, text, envelope, options, config, logger }: TransportMessage<Options, Config>): Promise<SendResult> => {
  const recordedAt = new Date().toISOString();
  // Sortable by time and unique; built from nothing the caller controls, so it cannot escape the directory.
  const id = `${recordedAt.replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const root = path.resolve(config.RECORDING_DIR);
  const finalDir = path.join(root, id);
  const tempDir = path.join(root, `.${id}.tmp`);

  try {
    await mkdir(tempDir, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(tempDir, "message.json"),
        JSON.stringify({ id, recordedAt, ...(options.tag ? { tag: options.tag } : {}), template, version, subject, envelope, files: FILES }, null, 2) + "\n",
        { flag: "wx" },
      ),
      writeFile(path.join(tempDir, "message.html"), html, { flag: "wx" }),
      writeFile(path.join(tempDir, "message.txt"), text, { flag: "wx" }),
    ]);
    await rename(tempDir, finalDir);
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    // The reason (a path, a permission, a full disk) goes to the log for the operator; the caller only learns that it failed.
    logger.error({ event: "mailjot.transport.recording.write_failed", directory: root, err }, `Recording transport could not write to "${root}"`);
    return { ok: false, reason: "unreachable", message: "Could not write the recording" };
  }

  return { ok: true, messageId: id, response: { recorded: id, files: FILES } };
};

export default send satisfies TransportModule<Options, Config>["default"];
