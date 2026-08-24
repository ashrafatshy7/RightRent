import { Router } from "express";
import { getCurrentRentalLaw } from "./rental-law.service.js";

export const rentalLawRouter = Router();

rentalLawRouter.get("/rental/current", async (_request, response) => {
  response.setHeader("Cache-Control", "public, max-age=900");
  response.json(await getCurrentRentalLaw());
});
