import type { RequestHandler } from "express";
import multer from "multer";
import { HttpError } from "../../shared/http/http-error.js";

export const MAX_CONTRACT_SIZE_BYTES = 10 * 1024 * 1024;

const parser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CONTRACT_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_request, file, callback) => {
    if (file.mimetype !== "application/pdf") {
      callback(
        new HttpError(
          415,
          "UNSUPPORTED_CONTRACT_TYPE",
          "The contract must be uploaded as application/pdf.",
        ),
      );
      return;
    }

    callback(null, true);
  },
}).single("contract");

export const parseContractUpload: RequestHandler = (request, response, next) => {
  parser(request, response, (error) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        next(
          new HttpError(
            413,
            "CONTRACT_TOO_LARGE",
            "The contract must not exceed 10 MB.",
          ),
        );
        return;
      }

      next(new HttpError(400, "INVALID_MULTIPART_UPLOAD", error.message));
      return;
    }

    next(error);
  });
};
