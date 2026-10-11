import { Router } from "express";
import { requireAuthentication } from "../auth/auth.middleware.js";
import { compareAnalyses } from "./comparison.service.js";

export const comparisonsRouter = Router();

comparisonsRouter.use(requireAuthentication);

comparisonsRouter.get("/:baseAnalysisId/:targetAnalysisId", async (request, response) => {
  response.json({
    comparison: await compareAnalyses(request.params.baseAnalysisId, request.params.targetAnalysisId, request.auth!.userId),
  });
});
