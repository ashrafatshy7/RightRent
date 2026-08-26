import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../shared/http/http-error.js";
import {
  approveLawVersion,
  getLawMonitoringStatus,
  syncLawKnowledgeBase,
} from "./law-sync.service.js";

export const lawManagementRouter = Router();

lawManagementRouter.post("/sync", async (_request, response) => {
  response.json({ checks: await syncLawKnowledgeBase() });
});

lawManagementRouter.get("/status", async (_request, response) => {
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

lawManagementRouter.post("/:israelLawId/approve", async (request, response) => {
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
