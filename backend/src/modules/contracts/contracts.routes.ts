import { Router } from "express";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { parse } from "../../shared/validation/parse.js";
import { analyzeRequestSchema } from "../../shared/validation/schemas.js";
import { analyzeContract, publicAnalysis } from "../analyses/analysis.service.js";
import { requireAuthentication } from "../auth/auth.middleware.js";
import { uploadContract } from "./contract-upload.controller.js";
import { parseContractUpload } from "./contract-upload.middleware.js";

export const contractsRouter = Router();

contractsRouter.use(requireAuthentication);
contractsRouter.post("/upload", parseContractUpload, uploadContract);
contractsRouter.post("/:id/analyze", async (request, response) => {
  const body = parse(analyzeRequestSchema, request.body);
  const user = await (await getStore()).findUserById(request.auth!.userId);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "The user account was not found.");
  const result = await analyzeContract(request.params.id, user.id, body.preferences ?? user.preferences);
  response.status(result.created ? 201 : 200).json({ analysis: publicAnalysis(result.analysis) });
});
