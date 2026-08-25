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

```bash
cp .env.example .env
npm install
npm run dev
```

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

## Security and privacy behavior

- Passwords are hashed with bcrypt; JWTs are signed, time-limited, issuer-bound, and audience-bound.
- All tenant data routes require a Bearer token and enforce resource ownership.
- Contract files are limited to one PDF and 10 MB, checked by MIME type, signature, and PDF parser,
  stored under UUID names, and written with private file permissions.
- Names, identity numbers, phone numbers, and addresses are redacted locally before any AI call.
  Monetary values remain because legal caps and budget preferences depend on them.
- Contract text is always presented to Claude as untrusted data, so embedded prompt instructions
  are never treated as system instructions.
- The law-sync endpoints use a separate internal token. Sources come from a fixed allowlist of
  Knesset identifiers and matching Wikisource titles, so requests cannot choose an upstream URL.
- Helmet, an origin allowlist, JSON body limits, HTTPS enforcement in production, and request rate
  limiting protect the HTTP boundary. State changes use Authorization headers rather than cookies,
  so they do not rely on ambient browser credentials and are resistant to CSRF.
- Deleting a history item removes the analysis record, contract record, original PDF, and marked PDF.

For a horizontally scaled production deployment, replace the process-local rate limiter with a
shared store at the infrastructure layer.

## API

Public:

- `GET /api/health`
- `POST /api/auth/register` — `{ "email": string, "password": string }`
- `POST /api/auth/login` — `{ "email": string, "password": string }`

Authenticated with `Authorization: Bearer <token>`:

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

Negotiation actions are `START`, `SET_PRIORITIES`, `CHOOSE_STRATEGY`, `SAVE_DRAFT`, and
`COMPLETE`. The only valid state path is `PRIORITIZE -> STRATEGY -> DRAFT -> COUNTER -> DONE`.
The backend prepares text but never contacts a landlord or sends a WhatsApp message.

Internal maintenance:

- `POST /internal/law/sync` with `X-Internal-Token`
- `GET /internal/law/status` with `X-Internal-Token`
- `POST /internal/law/:israelLawId/approve` with `X-Internal-Token` and
  `{ "revisionId": number, "verifiedBy": string, "verificationReference": string }`

The server starts an immediate source check and repeats it every hour. For each monitored law it
builds an official fingerprint from `KNS_IsraelLaw` and the sorted `KNS_LawBinding` rows, then
compares that fingerprint with the current rendered Wikisource revision. A Knesset change with no
matching consolidated-text change remains `OFFICIAL_UPDATE_PENDING`. A new Wikisource page
revision without a Knesset change is marked `WIKISOURCE_CHANGED`. When the official fingerprint
and effective rendered text change together, OpenAI embeddings are staged as
`AWAITING_VERIFICATION`. A same-revision content change caused by reaching a marked effective date
is staged for the same review. Candidate vectors become searchable only after the internal approval
endpoint records the reviewer and official verification reference. OData supplies change metadata,
not the consolidated section text or a reliable effective-date interpretation.

MongoDB stores `law_embeddings`, `law_source_states`, and `law_syncs`. `law_embeddings` contains
the vector, law/section identifiers, hashes, source URLs, the Wikisource revision, and status, but
never the statutory text. During analysis, the closest active vectors are selected first; their
exact Wikisource revision is then fetched into memory, re-hashed, used as model context, and
discarded. A hash mismatch fails closed.

Configure an Atlas Vector Search index named by `MONGODB_VECTOR_INDEX` over the `embedding` field
using cosine similarity, and add `status` as a filter field. In a horizontally scaled deployment,
run the hourly scheduler in exactly one worker or protect it with a distributed lease.

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

Text PDFs are extracted with `pdfjs-dist`, preserving page coordinates. Image-only PDFs are
rendered with `@napi-rs/canvas` and passed through Tesseract.js using `OCR_LANGUAGE`. The marked
copy is produced by `pdf-lib` without altering the original upload.
