import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { defaultPreferences, type UserRecord } from "../../domain/models.js";
import { getStore } from "../../shared/data/store.js";
import { HttpError } from "../../shared/http/http-error.js";

function publicUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    preferences: user.preferences,
    createdAt: user.createdAt,
  };
}

function tokenFor(userId: string) {
  return jwt.sign({}, env.jwtSecret, {
    algorithm: "HS256",
    subject: userId,
    issuer: "rightrent-backend",
    audience: "rightrent-client",
    expiresIn: env.jwtExpiresInSeconds,
  });
}

export async function register(email: string, password: string) {
  const store = await getStore();
  if (await store.findUserByEmail(email)) {
    throw new HttpError(409, "EMAIL_ALREADY_REGISTERED", "An account already exists for this email.");
  }

  const now = new Date().toISOString();
  const user: UserRecord = {
    id: randomUUID(),
    email,
    passwordHash: await bcrypt.hash(password, env.bcryptRounds),
    preferences: defaultPreferences,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await store.createUser(user);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "DUPLICATE_EMAIL" || ("code" in error && error.code === 11_000))
    ) {
      throw new HttpError(409, "EMAIL_ALREADY_REGISTERED", "An account already exists for this email.");
    }
    throw error;
  }

  return { token: tokenFor(user.id), user: publicUser(user) };
}

export async function login(email: string, password: string) {
  const user = await (await getStore()).findUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "The email or password is incorrect.");
  }
  return { token: tokenFor(user.id), user: publicUser(user) };
}

export function verifyAccessToken(token: string) {
  try {
    const payload = jwt.verify(token, env.jwtSecret, {
      algorithms: ["HS256"],
      issuer: "rightrent-backend",
      audience: "rightrent-client",
    });
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      throw new Error("missing subject");
    }
    return payload.sub;
  } catch {
    throw new HttpError(401, "INVALID_ACCESS_TOKEN", "The access token is invalid or expired.");
  }
}
