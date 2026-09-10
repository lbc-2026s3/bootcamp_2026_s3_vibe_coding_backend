import crypto from "node:crypto";
import { SiweMessage, generateNonce } from "siwe";
import type { Request, Response, NextFunction } from "express";

const nonces = new Map<string, { nonce: string; expiresAt: number }>();
const NONCE_TTL_MS = 5 * 60 * 1000;

export function createNonceHandler(_req: Request, res: Response): void {
  const nonce = generateNonce();
  const sessionId = crypto.randomUUID();
  nonces.set(sessionId, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  res.json({ nonce, sessionId });
}

type VerifyBody = {
  message?: string;
  signature?: string;
  sessionId?: string;
};

export async function verifySiweHandler(req: Request, res: Response): Promise<void> {
  const { message, signature, sessionId } = req.body as VerifyBody;

  if (!message || !signature || !sessionId) {
    res.status(400).json({ error: "缺少 message、signature 或 sessionId" });
    return;
  }

  const session = nonces.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    nonces.delete(sessionId);
    res.status(401).json({ error: "nonce 已过期，请重新获取" });
    return;
  }

  try {
    const siweMessage = new SiweMessage(message);
    await siweMessage.verify({ signature, nonce: session.nonce });
    nonces.delete(sessionId);

    const token = Buffer.from(
      JSON.stringify({
        address: siweMessage.address.toLowerCase(),
        chainId: siweMessage.chainId,
        exp: Date.now() + 24 * 60 * 60 * 1000,
      }),
    ).toString("base64url");

    res.json({
      token,
      address: siweMessage.address,
      chainId: siweMessage.chainId,
    });
  } catch (error) {
    res.status(401).json({
      error: "SIWE 验证失败",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export type AuthPayload = {
  address: string;
  chainId: number;
  exp: number;
};

export function parseAuthToken(token: string): AuthPayload | null {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as AuthPayload;
    if (!payload.address || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "未登录" });
    return;
  }

  const payload = parseAuthToken(header.slice("Bearer ".length));
  if (!payload) {
    res.status(401).json({ error: "登录已过期，请重新签名" });
    return;
  }

  res.locals.auth = payload;
  next();
}
