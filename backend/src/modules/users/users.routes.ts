import { Router } from "express";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";
import { parse } from "../../shared/validation/parse.js";
import { preferencesSchema } from "../../shared/validation/schemas.js";
import { requireAuthentication } from "../auth/auth.middleware.js";

export const usersRouter = Router();

usersRouter.use(requireAuthentication);

usersRouter.get("/preferences", async (request, response) => {
  const user = await (await getStore()).findUserById(request.auth!.userId);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "The user account was not found.");
  response.json({ preferences: user.preferences });
});

usersRouter.put("/preferences", async (request, response) => {
  const preferences = parse(preferencesSchema, request.body);
  const user = await (await getStore()).updateUserPreferences(request.auth!.userId, preferences);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "The user account was not found.");
  response.json({ preferences: user.preferences });
});
