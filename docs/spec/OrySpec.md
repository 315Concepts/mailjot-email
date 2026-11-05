# Ory Kratos emails

Research notes: every email Ory Kratos' courier can send, and the parameters each one's template receives. This is input for writing mailjot templates that stand in for Kratos' own (for example, one mailjot template per Kratos template type).

Terms follow the [README](../README.md): a **template** is an email yet to be built, a **document** is a built one.

## Sources and caveats

Researched on 2026-11-01 from:

- The Kratos documentation, "Custom email templates" (`ory.com/docs/kratos/emails-sms/custom-email-templates`).
- The Kratos source on `master`: `courier/template/type.go` (the type constants) and `courier/template/email/*.go` (one model struct per email).

Caveats:

- Read from `master`, not a pinned release. Check the version you deploy against.
- `authenticator_key_added` exists in the source but is **not in the documentation's table**. Treat it as less stable.
- Each model's `json` tag is the key Kratos uses when it sends the model over its HTTP courier; Go template files reference the Go field name instead (`{{ .RecoveryCode }}`). Both are given below.
- I did not verify Kratos' default subject lines or default body wording, so this document does not specify them.
- The `OAuth2LoginRequest` struct definition (outside `courier/template/email/`) could not be fetched. Its fields come from the documentation only.

## The emails

There are 13 template types in `type.go`; 12 are real emails and one (`stub`) is a test fixture. They fall into six flows. Each flow has a "valid" email (sent to a known address) and, for recovery and verification, an "invalid" email (sent when the address is unknown, so that account existence is not revealed).

| Flow | Template type | Sent when |
| --- | --- | --- |
| Recovery (link) | `recovery_valid` | A known address requests account recovery |
| Recovery (link) | `recovery_invalid` | An unknown address requests account recovery |
| Recovery (code) | `recovery_code_valid` | As above, with the code method |
| Recovery (code) | `recovery_code_invalid` | As above, with the code method |
| Verification (link) | `verification_valid` | An address needs verifying |
| Verification (link) | `verification_invalid` | An unknown address requests verification |
| Verification (code) | `verification_code_valid` | As above, with the code method |
| Verification (code) | `verification_code_invalid` | As above, with the code method |
| Login (code) | `login_code_valid` | Passwordless login by emailed code |
| Registration (code) | `registration_code_valid` | Registration by emailed code |
| Address change | `verifiable_address_changed` | A verifiable address on an identity was changed |
| Authenticator | `authenticator_key_added` | An authenticator key was added to an identity (undocumented) |
| Test | `stub` | Kratos' own tests only; never sent in production |

"Sent when" is inferred from the type names and the documentation; I did not trace the Kratos code paths that trigger each one.

Configuration names (under `courier.templates` in the Kratos config) differ from the runtime type: `recovery.valid` is `recovery_valid` for the link method and `recovery_code_valid` for the code method, `verification_code.valid` is `verification_code_valid`, and so on. The documentation lists no configuration name for `verifiable_address_changed`, `authenticator_key_added` or `stub` beyond the type itself.

## Parameters per email

Types: `string` unless noted. `map` is `map[string]any`: a free-form JSON object whose shape depends on the deployment's identity schema.

### Common to every email

| Go field | JSON key | Type | Notes |
| --- | --- | --- | --- |
| `To` | `to` | string | Recipient address |
| `TransientPayload` | `transient_payload` | map | Caller-supplied data passed through a flow. Present on every model except `stub`. |
| `RequestURL` | `request_url` | string | URL of the originating flow request. Present on every model except `verifiable_address_changed`, `authenticator_key_added` and `stub`. |

These two are listed once here and omitted from the per-email tables below.

### Recovery

**`recovery_valid`** (link)

| Go field | JSON key | Type |
| --- | --- | --- |
| `RecoveryURL` | `recovery_url` | string |
| `Identity` | `identity` | map |
| `ExpiresInMinutes` | `expires_in_minutes` | int |

**`recovery_code_valid`** (code)

| Go field | JSON key | Type |
| --- | --- | --- |
| `RecoveryCode` | `recovery_code` | string |
| `Identity` | `identity` | map |
| `ExpiresInMinutes` | `expires_in_minutes` | int |

**`recovery_invalid`** and **`recovery_code_invalid`**

No parameters beyond the common ones.

### Verification

**`verification_valid`** (link)

| Go field | JSON key | Type |
| --- | --- | --- |
| `VerificationURL` | `verification_url` | string |
| `Identity` | `identity` | map |
| `ExpiresInMinutes` | `expires_in_minutes` | int |
| `OAuth2LoginRequest` | `oauth2_login_request` | object, optional (see below) |

**`verification_code_valid`** (code)

| Go field | JSON key | Type |
| --- | --- | --- |
| `VerificationCode` | `verification_code` | string |
| `VerificationURL` | `verification_url` | string |
| `Identity` | `identity` | map |
| `ExpiresInMinutes` | `expires_in_minutes` | int |
| `OAuth2LoginRequest` | `oauth2_login_request` | object, optional (see below) |

**`verification_invalid`** and **`verification_code_invalid`**

No parameters beyond the common ones.

### Login and registration by code

**`login_code_valid`**

| Go field | JSON key | Type |
| --- | --- | --- |
| `LoginCode` | `login_code` | string |
| `Identity` | `identity` | map |
| `ExpiresInMinutes` | `expires_in_minutes` | int |
| `OAuth2LoginRequest` | `oauth2_login_request` | object, optional (see below) |

**`registration_code_valid`**

There is no `Identity` here, because the identity does not exist yet. The submitted traits are given instead.

| Go field | JSON key | Type |
| --- | --- | --- |
| `RegistrationCode` | `registration_code` | string |
| `Traits` | `traits` | map |
| `ExpiresInMinutes` | `expires_in_minutes` | int |
| `OAuth2LoginRequest` | `oauth2_login_request` | object, optional (see below) |

### Account changes

**`verifiable_address_changed`**

| Go field | JSON key | Type | Notes |
| --- | --- | --- | --- |
| `Identity` | `identity` | map | |
| `ChangedAt` | `changed_at` | string | A pre-formatted string, not a typed timestamp. The format is not specified in what I read. |

**`authenticator_key_added`** (undocumented)

| Go field | JSON key | Type | Notes |
| --- | --- | --- | --- |
| `Identity` | `identity` | map | |
| `AddedAt` | `added_at` | string | Pre-formatted string, as above |

### Test fixture

**`stub`** has its own shape and none of the common fields:

| Go field | JSON key | Type |
| --- | --- | --- |
| `To` | `to` | string |
| `Subject` | `subject` | string |
| `Body` | `body` | string |
| `HTMLBody` | `html_body` | string, optional |

## `OAuth2LoginRequest`

Set only when the flow began from an OAuth2 login challenge (Ory Hydra); otherwise absent. Available to `login_code_valid`, `registration_code_valid`, `verification_code_valid` and `verification_valid`. Fields, from the documentation:

| Field | Notes |
| --- | --- |
| `Challenge` | The OAuth2 login challenge |
| `Client.ClientID` | UUID |
| `Client.ClientName` | string |
| `Client.ClientURI` | string |
| `Client.LogoURI` | string |
| `Client.Metadata` | Free-form |

## `Identity` and `Traits`

`Identity` (and `Traits` in registration) is a free-form object. Its shape comes from each deployment's identity schema, so a mailjot template cannot declare it exactly. Templates would read it as `Identity.traits.<field>` (that path is my assumption from Kratos' identity model, not something I confirmed in the pages I read). A mailjot schema should declare only the traits the template uses, and `z.strictObject` would reject the rest, so a caller would have to pass a trimmed object (or the schema would need `z.looseObject` for that one field).

## Notes for mailjot

- **One template per type.** The 12 real types map naturally to 12 templates, for example `ory/recovery-valid`. The "invalid" ones are near-identical and take only `to`; they could differ only in wording.
- **Recipient is not template input in mailjot.** `to` is a Kratos parameter, but mailjot carries recipients in the envelope. A mailjot template normally would not need it unless the body quotes the address.
- **Dates and expiry are caller-formatted.** `ChangedAt` and `AddedAt` are strings and `ExpiresInMinutes` is an int, so they map directly onto a `z.string()` and `z.number().int()`.
- **Unconfirmed against a running Kratos.** Nothing here has been checked against a real instance's HTTP courier payload. Before building against it, capture one real payload per type.
