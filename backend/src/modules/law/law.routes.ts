import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { HttpError } from "../../shared/http/http-error.js";
import {
  approveLawVersion,
  getLawMonitoringStatus,
  syncLawKnowledgeBase,
} from "./law-sync.service.js";

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
  response.json({ checks: await syncLawKnowledgeBase() });
});

lawRouter.get("/status", async (_request, response) => {
  response.json({ laws: await getLawMonitoringStatus() });
});

const approvalSchema = z.object({
  revisionId: z.number().int().positive(),
  verifiedBy: z.string().trim().min(2).max(200),
  verificationReference: z.string().trim().min(5).max(2_000),
}).strict();

lawRouter.post("/:israelLawId/approve", async (request, response) => {
  const israelLawId = z.coerce.number().int().positive().safeParse(request.params.israelLawId);
  const approval = approvalSchema.safeParse(request.body);
  if (!israelLawId.success || !approval.success) {
    throw new HttpError(400, "INVALID_LAW_APPROVAL", "The law approval payload is invalid.");
  }
  response.json({
    law: await approveLawVersion(
      israelLawId.data,
      approval.data.revisionId,
      approval.data.verifiedBy,
      approval.data.verificationReference,
    ),
  });
});
