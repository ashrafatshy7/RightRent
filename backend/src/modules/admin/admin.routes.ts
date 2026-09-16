import { Router } from "express";
import { requireAdministrator, requireAuthentication } from "../auth/auth.middleware.js";
import { lawManagementRouter } from "../law/law-management.routes.js";

export const adminRouter = Router();

adminRouter.use(requireAuthentication, requireAdministrator);
adminRouter.use("/laws", lawManagementRouter);
