// Deliberately broken: violates the template contract in several ways (no schema, version, description,
// subject, component or examples), so loading it must fail with a contract error. The marker string below
// stands in for any internal detail that must never reach an HTTP response.
export const metadata = { id: "accounts/malformed", internalNote: "secret-contract-detail" };
