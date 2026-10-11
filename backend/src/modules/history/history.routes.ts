import { Router } from "express";
import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { requireAuthentication } from "../auth/auth.middleware.js";
import { publicAnalysis } from "../analyses/analysis.service.js";

export const historyRouter = Router();

historyRouter.use(requireAuthentication);

// Each analysis comes with its contract's name and place in the contract's version history, so the
// history can group the versions of one contract and offer to compare them.
historyRouter.get("/", async (request, response) => {
  const store = await getStore();
  const analyses = await store.listAnalyses(request.auth!.userId);
  const contracts = new Map(await Promise.all([...new Set(analyses.map((analysis) => analysis.contractId))]
    .map(async (contractId) => [contractId, await store.getContract(contractId)] as const)));
  response.json({
    analyses: analyses.map((analysis) => {
      const contract = contracts.get(analysis.contractId);
      return {
        ...publicAnalysis(analysis),
        contract: contract ? {
          id: contract.id,
          originalFileName: contract.originalFileName,
          version: contract.version ?? 1,
          rootContractId: contract.rootContractId ?? contract.id,
          previousContractId: contract.previousContractId ?? null,
        } : null,
      };
    }),
  });
});

historyRouter.delete("/:id", async (request, response) => {
  const store = await getStore();
  const analysis = await store.getAnalysis(request.params.id);
  if (!analysis || analysis.userId !== request.auth!.userId) {
    throw new HttpError(404, "ANALYSIS_NOT_FOUND", "The analysis was not found.");
  }
  const contract = await store.getContract(analysis.contractId);
  await store.deleteNegotiation(analysis.analysisId);
  await store.deleteAnalysis(analysis.analysisId);
  const remainingAnalyses = await store.countAnalysesByContract(analysis.contractId);
  if (remainingAnalyses === 0) {
    await store.deleteContract(analysis.contractId);
    await store.unlinkPreviousContract(analysis.contractId);
  }
  await Promise.all([
    analysis.markedPdf
      ? rm(path.join(env.markedPdfDirectory, analysis.markedPdf.storageKey), { force: true })
      : Promise.resolve(),
    contract && remainingAnalyses === 0
      ? rm(path.join(env.uploadDirectory, contract.storageKey), { force: true })
      : Promise.resolve(),
  ]);
  response.status(204).end();
});
