import { timingSafeEqual } from "node:crypto";
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

function tokenMatches(provided: string | undefined, expected: string) {
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

lawRouter.use((request, _response, next) => {
  if (!env.internalApiToken) {
    next(new HttpError(503, "INTERNAL_API_NOT_CONFIGURED", "INTERNAL_API_TOKEN is not configured."));
    return;
  }
  if (!tokenMatches(request.header("x-internal-token"), env.internalApiToken)) {
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
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sectionCount: z.number().int().positive(),
  sectionsHash: z.string().regex(/^[a-f0-9]{64}$/u),
  confirmedComplete: z.literal(true),
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
      approval.data.contentHash,
      approval.data.sectionCount,
      approval.data.sectionsHash,
      approval.data.verifiedBy,
      approval.data.verificationReference,
    ),
  });
});
