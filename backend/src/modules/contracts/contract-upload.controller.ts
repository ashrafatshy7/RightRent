import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RequestHandler } from "express";
import { env } from "../../config/env.js";
import type { ContractRecord } from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { extractPdf } from "./pdf-extraction.service.js";

const PDF_SIGNATURE = Buffer.from("%PDF-");

export const uploadContract: RequestHandler = async (request, response) => {
  const file = request.file;

  if (!file) {
    throw new HttpError(
      400,
      "CONTRACT_FILE_REQUIRED",
      'Upload one PDF using the multipart field "contract".',
    );
  }

  if (!file.buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    throw new HttpError(
      415,
      "INVALID_PDF_SIGNATURE",
      "The uploaded file does not have a valid PDF signature.",
    );
  }

  const contractId = randomUUID();
  const storedFileName = `${contractId}.pdf`;
  const uploadedAt = new Date().toISOString();
  const extraction = await extractPdf(file.buffer);
  const originalFileName = path.basename(file.originalname).replace(/[\u0000-\u001f\u007f]/g, "");

  await mkdir(env.uploadDirectory, { recursive: true });
  await writeFile(path.join(env.uploadDirectory, storedFileName), file.buffer, {
    flag: "wx",
    mode: 0o600,
  });

  const contract: ContractRecord = {
    id: contractId,
    userId: request.auth!.userId,
    originalFileName,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    storageKey: storedFileName,
    status: "EXTRACTED",
    isScanned: extraction.isScanned,
    extractionMs: extraction.extractionMs,
    clauses: extraction.clauses,
    uploadedAt,
    updatedAt: uploadedAt,
  };

  try {
    await (await getStore()).createContract(contract);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(path.join(env.uploadDirectory, storedFileName), { force: true });
    throw error;
  }

  response.status(201).json({
    contract: {
      id: contract.id,
      originalFileName: contract.originalFileName,
      mimeType: contract.mimeType,
      sizeBytes: contract.sizeBytes,
      status: contract.status,
      isScanned: contract.isScanned,
      scannedPages: extraction.scannedPages,
      pageCount: extraction.pageCount,
      clauseCount: contract.clauses.length,
      extractionMs: extraction.extractionMs,
      uploadedAt,
    },
  });
};
