import { Router } from "express";
import { parse } from "../../shared/validation/parse.js";
import { negotiationRequestSchema } from "../../shared/validation/schemas.js";
import { requireAuthentication } from "../auth/auth.middleware.js";
import { advanceNegotiation, getNegotiation } from "./negotiation.service.js";

export const negotiationsRouter = Router();

negotiationsRouter.use(requireAuthentication);

negotiationsRouter.get("/:analysisId", async (request, response) => {
  response.json({ negotiation: await getNegotiation(request.params.analysisId, request.auth!.userId) });
});

negotiationsRouter.post("/:analysisId", async (request, response) => {
  const action = parse(negotiationRequestSchema, request.body);
  response.json({
    negotiation: await advanceNegotiation(request.params.analysisId, request.auth!.userId, action),
  });
});
