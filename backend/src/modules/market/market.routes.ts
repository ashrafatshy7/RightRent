import { Router } from "express";
import { requireAuthentication } from "../auth/auth.middleware.js";
import { currentCpi } from "./cpi.service.js";

export const marketRouter = Router();

marketRouter.use(requireAuthentication);

marketRouter.get("/cpi", async (_request, response) => {
  response.json({ cpi: await currentCpi() });
});
