import { Router } from "express";
import { HttpError } from "../../shared/http/http-error.js";
import { parse } from "../../shared/validation/parse.js";
import { negotiationMessageSchema, negotiationRequestSchema } from "../../shared/validation/schemas.js";
import { requireAuthentication } from "../auth/auth.middleware.js";
import {
  completeNegotiation,
  finalizeNegotiationDraft,
  getNegotiation,
  saveDraftEdit,
  sendTenantMessage,
  startNegotiation,
} from "./negotiation.service.js";

const STREAM_TYPE = "application/x-ndjson";

export const negotiationsRouter = Router();

negotiationsRouter.use(requireAuthentication);

negotiationsRouter.get("/:analysisId", async (request, response) => {
  response.json({ negotiation: await getNegotiation(request.params.analysisId, request.auth!.userId) });
});

negotiationsRouter.post("/:analysisId", async (request, response) => {
  const action = parse(negotiationRequestSchema, request.body);
  const { analysisId } = request.params;
  const userId = request.auth!.userId;
  const negotiation = action.action === "START"
    ? await startNegotiation(analysisId, userId, action.restart ?? false)
    : action.action === "SAVE_DRAFT"
      ? await saveDraftEdit(analysisId, userId, action.draft)
      : action.action === "FINALIZE_DRAFT"
        ? await finalizeNegotiationDraft(analysisId, userId)
        : await completeNegotiation(analysisId, userId);
  response.json({ negotiation });
});

// One tenant message and the agent's reply, streamed as one JSON event per line: text deltas while
// the agent writes, the negotiation after each change it makes, and a final result or error line.
// Failures after headers are sent travel in-band, as in the analysis progress stream.
negotiationsRouter.post("/:analysisId/messages", async (request, response) => {
  const { text } = parse(negotiationMessageSchema, request.body);
  response.status(200).set({
    "content-type": `${STREAM_TYPE}; charset=utf-8`,
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const send = (event: object) => {
    if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
  };
  try {
    const negotiation = await sendTenantMessage(request.params.analysisId, request.auth!.userId, text, send);
    send({ type: "result", negotiation });
  } catch (error) {
    if (error instanceof HttpError) {
      send({ type: "error", status: error.status, error: { code: error.code, message: error.message } });
    } else {
      console.error(error);
      send({ type: "error", status: 500, error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred." } });
    }
  }
  response.end();
});
