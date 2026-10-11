import { Router } from "express";
import { access } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { parse } from "../../shared/validation/parse.js";
import { analyzeRequestSchema } from "../../shared/validation/schemas.js";
import { runWithAnalysisTrace } from "../analyses/analysis-logger.js";
import { analyzeContract, publicAnalysis } from "../analyses/analysis.service.js";
import { requireAuthentication } from "../auth/auth.middleware.js";
import { uploadContract } from "./contract-upload.controller.js";
import { parseContractUpload } from "./contract-upload.middleware.js";

const PROGRESS_STREAM_TYPE = "application/x-ndjson";

export const contractsRouter = Router();

contractsRouter.use(requireAuthentication);
contractsRouter.post("/upload", parseContractUpload, uploadContract);

// The original, unmarked PDF, for the in-browser viewer that draws its own interactive highlights.
contractsRouter.get("/:id/file", async (request, response) => {
  const contract = await (await getStore()).getContract(request.params.id);
  if (!contract || contract.userId !== request.auth!.userId) {
    throw new HttpError(404, "CONTRACT_NOT_FOUND", "The contract was not found.");
  }
  const filePath = path.join(env.uploadDirectory, contract.storageKey);
  try {
    await access(filePath);
  } catch {
    throw new HttpError(404, "CONTRACT_FILE_NOT_FOUND", "The contract file is no longer available.");
  }
  response.type("application/pdf");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Disposition", `inline; filename="rightrent-contract-${contract.id}.pdf"`);
  // `root` keeps send's dotfile guard on the stored file name only, not on the configured directory
  // (which may legitimately sit under a dot-directory, e.g. a worktree in .claude/).
  response.sendFile(contract.storageKey, { root: env.uploadDirectory });
});
contractsRouter.post("/:id/analyze", async (request, response) => {
  const body = parse(analyzeRequestSchema, request.body);
  const user = await (await getStore()).findUserById(request.auth!.userId);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "The user account was not found.");
  const preferences = body.preferences ?? user.preferences;

  if (!request.get("accept")?.includes(PROGRESS_STREAM_TYPE)) {
    const result = await analyzeContract(request.params.id, user.id, preferences);
    response.status(result.created ? 201 : 200).json({ analysis: publicAnalysis(result.analysis) });
    return;
  }

  // Progress stream for the browser console: one JSON event per line, ending with a result or
  // error line. Failures after headers are sent travel in-band instead of through errorHandler.
  response.status(200).set({
    "content-type": `${PROGRESS_STREAM_TYPE}; charset=utf-8`,
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const send = (event: object) => {
    if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
  };
  try {
    const result = await runWithAnalysisTrace(send, () =>
      analyzeContract(request.params.id, user.id, preferences));
    send({ type: "result", status: result.created ? 201 : 200, analysis: publicAnalysis(result.analysis) });
  } catch (error) {
    if (error instanceof HttpError) {
      send({
        type: "error",
        status: error.status,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    } else {
      console.error(error);
      send({
        type: "error",
        status: 500,
        error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred." },
      });
    }
  }
  response.end();
});
