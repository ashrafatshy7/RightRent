# RightRent Frontend

Hebrew, RTL React interface for the tenant contract-analysis flow and the administrator's
law-verification workflow. The frontend uses only the public and Bearer-authenticated backend API;
it never embeds MongoDB credentials, model credentials, or the internal law-maintenance token.

## Run locally

Start the backend on port 3000, then:

```bash
npm install
npm run dev
```

Vite opens the app at `http://localhost:5173` and proxies `/api` to
`http://127.0.0.1:3000`. For a separately hosted backend, copy `.env.example` to `.env` and set
`VITE_API_URL` to its public origin.

## Main flows

- Register and sign in with a short-lived Bearer session.
- Edit tenant preferences.
- Upload a PDF, confirm preferences, and begin analysis.
- Review clause findings, legal references, missing protections, and the marked PDF.
- Browse and delete private analysis history.
- For server-authorized administrators: inspect readiness and all 13 law states, synchronize
  sources, review the exact staged revision and hashes, and explicitly approve one candidate.

The admin navigation appears only when `/api/auth/me` returns `role: "ADMIN"`. Approval data is
read from the selected server candidate rather than typed or reconstructed by the browser.

## Verification

```bash
npm test
npm run build
npm run check
```
