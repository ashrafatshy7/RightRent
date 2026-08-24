import { Router } from "express";
import path from "node:path";
import { env } from "../../config/env.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { requireAuthentication } from "../auth/auth.middleware.js";
import { publicAnalysis } from "./analysis.service.js";

export const analysesRouter = Router();

analysesRouter.use(requireAuthentication);

analysesRouter.get("/:id", async (request, response) => {
  const analysis = await (await getStore()).getAnalysis(request.params.id);
  if (!analysis || analysis.userId !== request.auth!.userId) {
    throw new HttpError(404, "ANALYSIS_NOT_FOUND", "The analysis was not found.");
  }
  response.json({ analysis: publicAnalysis(analysis) });
});

analysesRouter.get("/:id/marked-pdf", async (request, response) => {
  const analysis = await (await getStore()).getAnalysis(request.params.id);
  if (!analysis || analysis.userId !== request.auth!.userId) {
    throw new HttpError(404, "ANALYSIS_NOT_FOUND", "The analysis was not found.");
  }
  if (!analysis.markedPdf) {
    throw new HttpError(404, "MARKED_PDF_NOT_FOUND", "The marked PDF is not available.");
  }
  response.type("application/pdf");
  response.setHeader("Content-Disposition", `inline; filename="rightrent-${analysis.analysisId}.pdf"`);
  response.sendFile(path.join(env.markedPdfDirectory, analysis.markedPdf.storageKey));
});
