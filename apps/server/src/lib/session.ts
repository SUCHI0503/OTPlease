import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { PrismaClient } from "@prisma/client";
import { env } from "./env";

const secretKey = new TextEncoder().encode(env.JWT_SECRET);

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  applicationId: string;
}

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function signAccessToken(ctx: AuthContext): Promise<string> {
  return new SignJWT({ sid: ctx.sessionId, aid: ctx.applicationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(ctx.userId)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey);
}

/** Refresh tokens look like "<sessionId>.<random>"; only the hash of the random part is stored. */
function newRefreshSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

async function tokensFor(ctx: AuthContext, refreshSecret: string): Promise<TokenPair> {
  return {
    accessToken: await signAccessToken(ctx),
    refreshToken: `${ctx.sessionId}.${refreshSecret}`,
    tokenType: "Bearer",
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function createSession(
  prisma: PrismaClient,
  applicationId: string,
  userId: string
): Promise<TokenPair> {
  const secret = newRefreshSecret();
  const session = await prisma.session.create({
    data: {
      applicationId,
      userId,
      refreshHash: sha256(secret),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    },
  });
  return tokensFor({ sessionId: session.id, userId, applicationId }, secret);
}

/**
 * Rotates the refresh token. Each refresh token works once; presenting an
 * already-rotated one is treated as theft and revokes the whole session.
 */
export async function refreshSession(
  prisma: PrismaClient,
  refreshToken: string
): Promise<TokenPair | null> {
  const [sessionId, secret] = refreshToken.split(".");
  if (!sessionId || !secret) return null;
  const presented = sha256(secret);
  const newSecret = newRefreshSecret();

  const rotated = await prisma.session.updateMany({
    where: {
      id: sessionId,
      refreshHash: presented,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { refreshHash: sha256(newSecret), prevRefreshHash: presented, lastUsedAt: new Date() },
  });

  if (rotated.count === 0) {
    await prisma.session.updateMany({
      where: { id: sessionId, prevRefreshHash: presented, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return null;
  }

  const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  return tokensFor(
    { sessionId, userId: session.userId, applicationId: session.applicationId },
    newSecret
  );
}

/** Verifies the JWT AND checks the session is still live on the server. */
export async function authenticate(
  prisma: PrismaClient,
  authorization: string | undefined
): Promise<AuthContext | null> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
    const sessionId = payload.sid as string;
    const session = await prisma.session.findFirst({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!session) return null;
    return { sessionId, userId: session.userId, applicationId: session.applicationId };
  } catch {
    return null;
  }
}

export async function revokeSession(prisma: PrismaClient, sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
