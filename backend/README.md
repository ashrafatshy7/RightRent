# RightRent Backend

Production-oriented Express and TypeScript backend for the flows defined in the RightRent
Project Book: tenant accounts and preferences, secure PDF upload, text/coordinate extraction,
local PII redaction, RAG-assisted legal analysis, deterministic severity classification,
marked PDFs, history, a persisted negotiation state machine, and law-corpus synchronization.

RightRent is a decision-support tool and does not provide legal advice. The engineering seed
corpus under `evaluation/` is not authoritative statutory text. A production deployment must
synchronize from a verified legal source and obtain legal review.

## Requirements and setup

- Node.js 20 or newer
- MongoDB Atlas for production; local development can use the in-memory data store
- OpenAI and Anthropic credentials when `ANALYSIS_PROVIDER=anthropic`

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
- The law-sync endpoint uses a separate internal token. Its source URL comes only from server
  configuration, which avoids a request-controlled SSRF target.
- Helmet, an origin allowlist, JSON body limits, HTTPS enforcement in production, and request rate
  limiting protect the HTTP boundary. State changes use Authorization headers rather than cookies,
  so they do not rely on ambient browser credentials and are resistant to CSRF.
- Deleting a history item removes the analysis record, contract record, original PDF, and marked PDF.

For a horizontally scaled production deployment, replace the process-local rate limiter with a
shared store at the infrastructure layer.

## API

Public:

- `GET /api/health`
- `GET /api/laws/rental/current` — the currently effective consolidated Rental and Lending Law;
  Knesset metadata is verified on every request and future or repealed Wikisource provisions are omitted
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

The configured law source may return a JSON `sections` array or HTML/plain text. Each validated
section is normalized, hashed, embedded with OpenAI, and atomically replaces the active
`law_chunks` corpus in MongoDB. Configure an Atlas Vector Search index named by
`MONGODB_VECTOR_INDEX` over the `embedding` field using cosine similarity.

## Analysis modes

`ANALYSIS_PROVIDER=deterministic` is the safe local and CI mode. It implements the documented
two-track assessment for the executable fixtures, applies the statutory security cap and repair
rule, evaluates tenant preference conflicts, detects missing protections, and never needs cloud
credentials.

`ANALYSIS_PROVIDER=anthropic` is the RAG mode from the Project Book. Each already-redacted clause
is embedded with OpenAI, the five closest law chunks are retrieved from Atlas Vector Search, and
Claude returns a structured assessment. Claude does not choose the color: the backend always
applies the deterministic rule `violation -> RED`, `risk/preference conflict -> ORANGE`, otherwise
`OK`. A claimed violation without a retrieved legal reference is rejected instead of being shown
to the tenant.

Text PDFs are extracted with `pdfjs-dist`, preserving page coordinates. Image-only PDFs are
rendered with `@napi-rs/canvas` and passed through Tesseract.js using `OCR_LANGUAGE`. The marked
copy is produced by `pdf-lib` without altering the original upload.
