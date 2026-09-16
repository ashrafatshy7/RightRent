# RightRent

RightRent is an RTL Hebrew web application for privacy-conscious rental-contract analysis. The
React frontend is connected to the Express backend for authentication, tenant preferences, PDF
analysis, history, marked documents, readiness, and controlled verification of the 13-law vector
corpus.

RightRent is a decision-support tool, not legal advice. A staged law becomes searchable only after
an administrator checks its exact revision, hashes, section manifest, and official reference.

## Local development

Use three terminals. First, run the local Hebrew NER service:

```bash
cd backend/services/hebrew-ner
docker build -t rightrent-hebrew-ner .
docker run --rm -p 127.0.0.1:8001:8001 \
  -e PII_NER_TOKEN=the-same-value-configured-in-backend-env \
  rightrent-hebrew-ner
```

Then start the backend:

```bash
cd backend
npm install
npm run dev
```

Finally, start the frontend:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` or `http://127.0.0.1:5173`. Keep both local origins in the backend
development environment: `CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`. The frontend
development server sends `/api` requests to the backend on port 3000.

To use the law dashboard, register or sign in with an email included in the backend's
comma-separated `ADMIN_EMAILS` setting. Open **ניהול מאגר החוקים**, run a sync when needed, select
a staged candidate, compare its Knesset and frozen Wikisource sources, fill in the reviewer and
verification reference, confirm completeness, and approve it. There is deliberately no bulk
approval.

Check readiness after the 13 laws have been approved:

```bash
curl http://localhost:3000/api/health/ready
```

For Anthropic analysis, readiness must show `activeLaws: "13/13"`, a positive
`activeEmbeddingCount`, `vectorSearch: true`, and `piiNer.ready: true`.

## Project checks

```bash
cd backend && npm run check
cd ../frontend && npm run check
```

Backend API and law-corpus details are documented in `backend/README.md`; frontend routes and
development behavior are documented in `frontend/README.md`.
