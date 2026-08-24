import type { RequestHandler } from "express";
import { HttpError } from "../../shared/http/http-error.js";
import { verifyAccessToken } from "./auth.service.js";

export const requireAuthentication: RequestHandler = (request, _response, next) => {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    next(new HttpError(401, "AUTHENTICATION_REQUIRED", "Provide a Bearer access token."));
    return;
  }

  request.auth = { userId: verifyAccessToken(authorization.slice("Bearer ".length)) };
  next();
};
