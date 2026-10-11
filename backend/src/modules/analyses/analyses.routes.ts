import { Router } from "express";
import { env } from "../../config/env.js";
import type { FinancialOverrides } from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { parse } from "../../shared/validation/parse.js";
import { costSimulationRequestSchema, financialOverridesSchema } from "../../shared/validation/schemas.js";
import { requireAuthentication } from "../auth/auth.middleware.js";
import { currentCpi } from "../market/cpi.service.js";
import { publicAnalysis } from "./analysis.service.js";
import { costInputs, simulateCost, type CostScenario } from "./cost-simulation.service.js";

export const analysesRouter = Router();

analysesRouter.use(requireAuthentication);

async function ownedAnalysis(analysisId: string, userId: string) {
  const analysis = await (await getStore()).getAnalysis(analysisId);
  if (!analysis || analysis.userId !== userId) {
    throw new HttpError(404, "ANALYSIS_NOT_FOUND", "The analysis was not found.");
  }
  return analysis;
}

analysesRouter.get("/:id", async (request, response) => {
  const analysis = await ownedAnalysis(request.params.id, request.auth!.userId);
  response.json({ analysis: publicAnalysis(analysis) });
});

// Runs the cost simulator on the analysis's financial terms with the tenant's saved corrections.
// Pure computation: nothing is stored, so the tenant can move the scenario sliders freely.
analysesRouter.post("/:id/cost-simulation", async (request, response) => {
  const body = parse(costSimulationRequestSchema, request.body ?? {});
  const analysis = await ownedAnalysis(request.params.id, request.auth!.userId);
  if (!analysis.financialTerms) {
    throw new HttpError(409, "FINANCIAL_TERMS_UNAVAILABLE", "This analysis predates the cost simulator; analyze the contract again.");
  }
  const cpi = await currentCpi();
  const scenario: CostScenario = {
    annualInflationPercent: body.scenario?.annualInflationPercent ?? cpi.last12MonthsPercent,
    includeOption: body.scenario?.includeOption ?? false,
    exitAfterMonth: body.scenario?.exitAfterMonth ?? null,
    replacementAfterMonths: body.scenario?.replacementAfterMonths ?? 2,
    lateVacatingDays: body.scenario?.lateVacatingDays ?? 0,
    latePaymentDays: body.scenario?.latePaymentDays ?? 0,
  };
  const inputs = costInputs(analysis.financialTerms, analysis.financialOverrides);
  response.json({ simulation: simulateCost(inputs, scenario, analysis.preferencesSnapshot), inputs, cpi });
});

// Setting a value confirms it; the whole set replaces the previous one.
analysesRouter.put("/:id/financial-overrides", async (request, response) => {
  // Only the fields actually set are kept (JSON has no undefined, but the parsed type allows it).
  const overrides = Object.fromEntries(
    Object.entries(parse(financialOverridesSchema, request.body)).filter(([, value]) => value !== undefined),
  ) as FinancialOverrides;
  const analysis = await ownedAnalysis(request.params.id, request.auth!.userId);
  await (await getStore()).saveFinancialOverrides(analysis.analysisId, overrides);
  response.json({ financialOverrides: overrides });
});

analysesRouter.get("/:id/marked-pdf", async (request, response) => {
  const analysis = await ownedAnalysis(request.params.id, request.auth!.userId);
  if (!analysis.markedPdf) {
    throw new HttpError(404, "MARKED_PDF_NOT_FOUND", "The marked PDF is not available.");
  }
  response.type("application/pdf");
  response.setHeader("Content-Disposition", `inline; filename="rightrent-${analysis.analysisId}.pdf"`);
  response.sendFile(analysis.markedPdf.storageKey, { root: env.markedPdfDirectory });
});
