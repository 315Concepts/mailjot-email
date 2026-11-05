// Version 1 of the contract between the engine and transport plugins.
//
// The interfaces are what plugins import, with `import type` only: transports are compiled and mounted
// separately from the engine, so they must never depend on anything here at runtime. The runtime half
// at the bottom (`transportContractV1`) is used only by the engine, through the v1 router.
import { z, type ZodType } from "zod";
import {
  createTransportLoader,
  TransportContractError,
  type ContractedTransport,
  type LoadedTransport,
  type TransportContract,
  type TransportLoader,
} from "../../transport.js";

export interface Address {
  email: string;
  name?: string;
}

/** Provider-neutral delivery fields. The engine validates these before any transport sees them. */
export interface Envelope {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address;
}

/**
 * The logger a transport receives with every message. The engine hands over its own request logger, scoped so that
 * each line already carries the request ID, the API version, the transport's name and the template. A transport
 * writes events, not content: the fields are the first argument, a short human sentence is the second.
 *
 * Log what happened and how it went (an HTTP status, an error code, a duration). Never log the message itself
 * (`subject`, `html`, `text`, `envelope`, or the values in `options`), credentials from `config`, or a provider's
 * response body or error text, which can echo a recipient. Use an event name of the form `mailjot.transport.<id>.<what>`.
 */
export interface TransportLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** A fully rendered email plus where it should go. */
export interface TransportMessage<Options = Record<string, never>, Config = unknown> {
  /** Identity and version of the template that was rendered. */
  template: string;
  version: string;
  subject: string;
  html: string;
  text: string;
  envelope: Envelope;
  /** Provider-specific extras, validated against the transport's `options` schema. */
  options: Options;
  /** Settings parsed from the environment by the transport's `config` schema. */
  config: Config;
  /** Where the transport logs. Always provided; see `TransportLogger` for what belongs in it. */
  logger: TransportLogger;
}

/**
 * What a transport reports back. Failures are values, not exceptions, so a transport never needs
 * engine classes. An exception escaping `send` is treated as an internal error.
 *
 * - `rejected`: the provider received the request and refused it (bad address, auth, quota, ...).
 * - `unreachable`: the provider could not be reached or did not answer usefully.
 */
export type SendResult =
  | { ok: true; messageId?: string; response: unknown }
  | { ok: false; reason: "rejected" | "unreachable"; message: string; response?: unknown };

/** The shape of a transport module (`transports/v<N>/<Name>.tsx`). */
export interface TransportModule<Options = Record<string, never>, Config = unknown> {
  /** `id` must equal the file name. */
  metadata: { id: string; description: string };
  /** Zod schema over environment variables (keys, endpoints). Invalid config makes the transport unavailable. */
  config: ZodType<Config>;
  /** Optional schema for provider-specific request extras. Defaults to "no options". */
  options?: ZodType<Options>;
  default: (message: TransportMessage<Options, Config>) => Promise<SendResult>;
}

// ---------------------------------------------------------------------------------------------
// Runtime half (engine only)
// ---------------------------------------------------------------------------------------------

/** What the v1 sender hands a transport: the message without its config, which the loader adds. */
export type V1Message = Omit<TransportMessage<Record<string, unknown>>, "config">;

export type V1LoadedTransport = LoadedTransport<V1Message, SendResult>;
export type V1TransportLoader = TransportLoader<V1Message, SendResult>;

const noOptions = z.strictObject({});

/** Checks a module against the v1 transport contract. */
export const transportContractV1: TransportContract<V1Message, SendResult> = {
  assert(name, mod): ContractedTransport<V1Message, SendResult> {
    const problems: string[] = [];

    const meta = mod.metadata as Partial<TransportModule["metadata"]> | undefined;
    if (typeof meta !== "object" || meta === null) {
      problems.push("`metadata` must be an object");
    } else {
      if (typeof meta.id !== "string" || meta.id === "") problems.push("`metadata.id` must be a non-empty string");
      else if (meta.id !== name) problems.push(`\`metadata.id\` ("${meta.id}") must match the directory name ("${name}")`);
      if (typeof meta.description !== "string" || meta.description === "") {
        problems.push("`metadata.description` must be a non-empty string");
      }
    }
    if (!(mod.config instanceof z.ZodType)) problems.push("`config` must be a Zod schema over environment variables");
    if (mod.options !== undefined && !(mod.options instanceof z.ZodType)) problems.push("`options`, if present, must be a Zod schema");
    if (typeof mod.default !== "function") problems.push("`default` must be a send function");

    if (problems.length > 0) throw new TransportContractError(name, problems);

    const send = mod.default as TransportModule<Record<string, unknown>, unknown>["default"];
    return {
      description: (mod.metadata as TransportModule["metadata"]).description,
      config: mod.config as z.ZodType<unknown>,
      options: (mod.options ?? noOptions) as z.ZodType<Record<string, unknown>>,
      send: (message, config) => send({ ...message, config }),
    };
  },
};

/** A loader for one v1 transports directory (`transports/v1`). */
export function createV1TransportLoader(root: string, options: { env?: Record<string, string | undefined> } = {}): V1TransportLoader {
  return createTransportLoader(root, { ...options, contract: transportContractV1 });
}
