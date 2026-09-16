# RightRent Backend

Production-oriented Express and TypeScript backend for the flows defined in the RightRent
Project Book: tenant accounts and preferences, secure PDF upload, text/coordinate extraction,
local PII redaction, RAG-assisted legal analysis, deterministic severity classification,
marked PDFs, history, a persisted negotiation state machine, and law-corpus synchronization.

RightRent is a decision-support tool and does not provide legal advice. Runtime statutory text is
not committed to the backend and is not stored in MongoDB. A production deployment must review
every candidate consolidation against the official publication before activating its embeddings.

## Requirements and setup

- Node.js 20.18.1 or newer
- MongoDB Atlas for production; local development can use the in-memory data store
- OpenAI credentials for law synchronization and vector retrieval
- Anthropic credentials when `ANALYSIS_PROVIDER=anthropic`
- Docker (or Python 3.11) for the local DictaBERT Hebrew NER sidecar

```bash
cp .env.example .env
npm install
npm run dev
```

`ADMIN_EMAILS` is a comma-separated allowlist. A registered account whose normalized email is in
that list receives the `ADMIN` role from the server and can use the law-review dashboard. The role
is never accepted from a client request or stored in a browser-editable profile field.

`ANALYSIS_PROVIDER=deterministic` is the offline fixture mode. Before enabling
`ANALYSIS_PROVIDER=anthropic`, start `services/hebrew-ner`, set
`PII_NER_MODE=dictabert`, and configure the same private `PII_NER_TOKEN` in both
processes. Startup rejects Anthropic mode when NER is left in regex-only mode.

Local `.env` values are loaded automatically; process-level variables take precedence. Production startup rejects a
missing `MONGODB_URI`, a short `JWT_SECRET`, and non-HTTPS requests (the app trusts one reverse
proxy hop).

Useful verification commands:

```bash
npm run typecheck
npm test
npm run evaluation
npm run build
npm run check
```

`npm test` forces the in-memory store and temporary file directories, so it cannot mutate the
MongoDB configured in `.env`. `npm run build` removes the previous generated `dist` before compiling,
preventing deleted source modules from surviving as stale production code.

## Security and privacy behavior

- Passwords are hashed with bcrypt; JWTs are signed, time-limited, issuer-bound, and audience-bound.
- All tenant data routes require a Bearer token and enforce resource ownership.
- Contract files are limited to one PDF and 10 MB, checked by MIME type, signature, and PDF parser,
  stored under UUID names, and written with private file permissions.
- A regex pass removes direct identifiers and a local `dicta-il/dictabert-ner` pass removes Hebrew
  people, organizations, and locations before any cloud AI call. Residual IDs, phones, email
  addresses, or IBANs stop analysis fail-closed. Monetary values remain because legal caps and
  budget preferences depend on them.
- Contract text is always presented to Claude as untrusted data, so embedded prompt instructions
  are never treated as system instructions.
- The law-sync endpoints use a separate internal token. Sources come from a fixed allowlist of
  Knesset identifiers and matching Wikisource titles, so requests cannot choose an upstream URL.
- Helmet, an origin allowlist, JSON body limits, HTTPS enforcement in production, and request rate
  limiting protect the HTTP boundary. State changes use Authorization headers rather than cookies,
  so they do not rely on ambient browser credentials and are resistant to CSRF.
- Deleting a history item removes the analysis record, contract record, original PDF, and marked PDF.

MongoDB-backed deployments share rate-limit counters across application instances; the in-memory
driver keeps equivalent process-local counters for tests and offline development.

## API

Public:

- `GET /api/health`
- `GET /api/health/ready` — database readiness and, in RAG mode, all 13 active laws,
  Vector Search, and local NER readiness
- `POST /api/auth/register` — `{ "email": string, "password": string }`
- `POST /api/auth/login` — `{ "email": string, "password": string }`

Authenticated with `Authorization: Bearer <token>`:

- `GET /api/auth/me`
- `GET /api/users/preferences`
- `PUT /api/users/preferences`
- `POST /api/contracts/upload` — multipart field `contract`
- `POST /api/contracts/:id/analyze` — `{ "confirmPreferences": true, "preferences"?: ... }`
- `GET /api/analyses/:id`
- `GET /api/analyses/:id/marked-pdf`
- `GET /api/history`
- `DELETE /api/history/:id`
- `GET /api/negotiation/:analysisId`
- `POST /api/negotiation/:analysisId`

Administrator, authenticated with the same Bearer token and restricted by `ADMIN_EMAILS`:

- `GET /api/admin/laws/status`
- `POST /api/admin/laws/sync`
- `POST /api/admin/laws/:israelLawId/approve` with
  `{ "revisionId": number, "contentHash": string, "sectionCount": number,
  "sectionsHash": string, "confirmedComplete": true, "verifiedBy": string,
  "verificationReference": string }`

These are the browser-safe management routes used by the frontend. The server verifies the
administrator from its own allowlist; the frontend never receives or sends the internal
maintenance token.

Negotiation actions are `START`, `SET_PRIORITIES`, `CHOOSE_STRATEGY`, `SAVE_DRAFT`, and
`COMPLETE`. The only valid state path is `PRIORITIZE -> STRATEGY -> DRAFT -> COUNTER -> DONE`.
The backend prepares text but never contacts a landlord or sends a WhatsApp message.

Internal maintenance:

- `POST /internal/law/sync` with `X-Internal-Token`
- `GET /internal/law/status` with `X-Internal-Token`
- `POST /internal/law/:israelLawId/approve` with `X-Internal-Token` and
  `{ "revisionId": number, "contentHash": string, "sectionCount": number,
  "sectionsHash": string, "confirmedComplete": true, "verifiedBy": string,
  "verificationReference": string }`

The server starts an immediate source check and repeats it every hour. For each monitored law it
builds an official fingerprint from `KNS_IsraelLaw` and the sorted `KNS_LawBinding` rows, then
compares that fingerprint with the current rendered Wikisource revision. A Knesset change with no
matching consolidated-text change remains `OFFICIAL_UPDATE_PENDING`. A new Wikisource page
revision without a Knesset change is marked `WIKISOURCE_CHANGED`. When the official fingerprint
and effective rendered text change together, OpenAI embeddings are staged as
`AWAITING_VERIFICATION`. A same-revision content change caused by reaching a marked effective date
is staged for the same review. Candidate vectors become searchable only after the internal approval
endpoint records the exact content hash, complete section manifest, reviewer, and official
verification reference. The status response exposes candidate section keys for that review.
OData supplies change metadata,
not the consolidated section text or a reliable effective-date interpretation.

MongoDB stores `law_embeddings`, `law_source_states`, and `law_syncs`. `law_embeddings` contains
the vector, law/section identifiers, hashes, source URLs, the Wikisource revision, and status, but
never the statutory text. During analysis, the closest active vectors are selected first; their
exact Wikisource revision is then fetched into memory, re-hashed, used as model context, and
discarded. A hash mismatch fails closed.

By default the backend creates the Atlas Vector Search index named by `MONGODB_VECTOR_INDEX` with
the configured dimensions, cosine similarity, and `status` filter. Set
`MONGODB_MANAGE_VECTOR_INDEX=false` only when deployment infrastructure owns the index. A MongoDB
lease prevents duplicate hourly schedulers across application instances, and new `law_syncs`
records expire after `LAW_SYNC_RETENTION_DAYS`.

The Knesset metadata and official publications remain the legal source of record. Wikisource is a
secondary consolidated source linked by the Knesset, not an official publication. When exposing
user-facing citations, include its source URL and revision and comply with the applicable CC BY-SA
attribution/share-alike terms.

## Analysis modes

`ANALYSIS_PROVIDER=deterministic` is a local and CI fixture mode and is rejected in production. It implements the documented
two-track assessment for the executable fixtures, applies the statutory security cap and repair
rule, evaluates tenant preference conflicts, detects missing protections, and never needs cloud
credentials.

`ANALYSIS_PROVIDER=anthropic` is the RAG mode from the Project Book. Each already-redacted clause
is embedded with OpenAI, the five closest verified law vectors are retrieved from Atlas Vector
Search, their source text is hydrated temporarily, and Claude returns a structured assessment.
Claude does not choose the color: the backend always
applies the deterministic rule `violation -> RED`, `risk/preference conflict -> ORANGE`, otherwise
`OK`. A claimed violation without a retrieved legal reference is rejected instead of being shown
to the tenant.

In parallel with clause analysis, a separate contract-level Claude request evaluates every
predefined protection as `COVERED`, `PARTIAL`, or `MISSING`, maps it to clause IDs, and suggests
text for incomplete protections. RAG analysis is disabled unless all 13 monitored laws have
approved `ACTIVE` versions.

Claude calls use `ANTHROPIC_MODEL` (default `claude-sonnet-5`) with adaptive thinking and a
per-call effort level, and always stream: a call fails only when its stream stays silent for 60
seconds. Rate limits, overload, and connection failures are retried; timeouts and broken streams
are not, because the partial response is already billed. Each clause verdict and protection report
is saved in `ai_result_cache` for seven days, keyed by a hash of the tenant, preferences, active law
versions, redacted input, and request configuration, so retrying a failed analysis pays only for
the calls that did not finish.

Text PDFs are extracted with `pdfjs-dist`, preserving text-item coordinates. Every scanned page,
including a scanned page inside a mixed PDF, is rendered with `@napi-rs/canvas`; Tesseract.js word
boxes are converted back to PDF coordinates. Logical clauses longer than 300 words are split near
a 250-word target. The marked copy is produced by `pdf-lib` without altering the original upload.

## Release evidence

Unit and API tests do not establish the Project Book's legal targets. Put reviewed live-run JSON
artifacts in `evaluation/results` and run `npm run evaluation:release`. The gate rejects fewer than
10 annotated contracts and measures 90% violation recall, 95% RED/ORANGE precision, 85% missing-
protection recall, model-bound PII leakage, and the 90-second target.

Run `npm run test:load` only against a disposable staging database after setting
`RIGHTRENT_LOAD_CONFIRM_DISPOSABLE=true`, `RIGHTRENT_BASE_URL`, and `RIGHTRENT_LOAD_PDF`. It performs
10 concurrent user analyses. Monitor `/api/health/ready` externally during deployment to calculate
the required 99% availability.
