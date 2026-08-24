import { Router } from "express";
import { env } from "../../config/env.js";
import { HttpError } from "../../shared/http/http-error.js";
import { syncLawKnowledgeBase } from "./law-sync.service.js";

export const lawRouter = Router();

lawRouter.use((request, _response, next) => {
  if (!env.internalApiToken) {
    next(new HttpError(503, "INTERNAL_API_NOT_CONFIGURED", "INTERNAL_API_TOKEN is not configured."));
    return;
  }
  if (request.header("x-internal-token") !== env.internalApiToken) {
    next(new HttpError(401, "INVALID_INTERNAL_TOKEN", "The internal API token is invalid."));
    return;
  }
  next();
});

lawRouter.post("/sync", async (_request, response) => {
  response.json({ sync: await syncLawKnowledgeBase() });
});
