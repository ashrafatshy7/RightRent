import type { RequestHandler } from "express";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { isAdministrator, verifyAccessToken } from "./auth.service.js";

export const requireAuthentication: RequestHandler = (request, _response, next) => {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    next(new HttpError(401, "AUTHENTICATION_REQUIRED", "Provide a Bearer access token."));
    return;
  }

  request.auth = { userId: verifyAccessToken(authorization.slice("Bearer ".length)) };
  next();
};

export const requireAdministrator: RequestHandler = async (request, _response, next) => {
  const user = request.auth
    ? await (await getStore()).findUserById(request.auth.userId)
    : null;
  if (!user || !isAdministrator(user.email)) {
    next(new HttpError(403, "ADMINISTRATOR_REQUIRED", "Administrator access is required."));
    return;
  }
  next();
};
