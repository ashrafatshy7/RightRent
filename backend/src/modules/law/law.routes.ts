import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { env } from "../../config/env.js";
import { HttpError } from "../../shared/http/http-error.js";
import { lawManagementRouter } from "./law-management.routes.js";

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
lawRouter.use(lawManagementRouter);
