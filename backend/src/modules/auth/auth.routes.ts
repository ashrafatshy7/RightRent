import { Router } from "express";
import { parse } from "../../shared/validation/parse.js";
import { credentialsSchema } from "../../shared/validation/schemas.js";
import { requireAuthentication } from "./auth.middleware.js";
import { getCurrentUser, login, register } from "./auth.service.js";

export const authRouter = Router();

authRouter.post("/register", async (request, response) => {
  const credentials = parse(credentialsSchema, request.body);
  response.status(201).json(await register(credentials.email, credentials.password));
});

authRouter.post("/login", async (request, response) => {
  const credentials = parse(credentialsSchema, request.body);
  response.json(await login(credentials.email, credentials.password));
});

authRouter.get("/me", requireAuthentication, async (request, response) => {
  response.json({ user: await getCurrentUser(request.auth!.userId) });
});
