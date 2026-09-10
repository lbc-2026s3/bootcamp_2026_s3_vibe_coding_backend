/**
 * SIWE（Sign-In with Ethereum）认证模块。
 *
 * 流程：
 * 1. GET /api/auth/nonce → 返回 nonce + sessionId
 * 2. 前端用钱包签名 SIWE message
 * 3. POST /api/auth/verify → 验签成功后返回 token
 * 4. 后续请求在 Authorization: Bearer <token> 中携带 token
 */

import crypto from "node:crypto";
import { SiweMessage, generateNonce } from "siwe";
import type { Request, Response, NextFunction } from "express";

/** 内存中的 nonce 会话，key 为 sessionId */
const nonces = new Map<string, { nonce: string; expiresAt: number }>();
/** nonce 有效期：5 分钟 */
const NONCE_TTL_MS = 5 * 60 * 1000;

/** 生成 SIWE 登录所需的 nonce 与 sessionId */
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

/** 验证 SIWE 签名，成功后签发 24 小时有效的 token */
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

    // 简易 token：base64url 编码的 JSON（教学/demo 用）。
    // 缺陷：无签名，客户端可随意伪造 payload，服务端只能解码 + 看 exp，无法验证真伪。
    // 生产环境应改用 JWT + 密钥签名（如 HS256 或 RS256）：
    //   1. 服务端持有 JWT_SECRET（对称）或 RSA 私钥（非对称）
    //   2. SIWE 验签成功后，用密钥签发 JWT（payload 含 address、chainId、exp）
    //   3. 客户端原样携带 JWT；requireAuth 中用同一密钥验签，篡改或过期则拒绝
    // 详见 docs/SIWE_AND_INDEXING.md「Demo token 与生产环境 JWT」
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

/** token 解码后的载荷 */
export type AuthPayload = {
  address: string;
  chainId: number;
  exp: number;
};

/** 解析并校验 token，过期或格式错误时返回 null */
export function parseAuthToken(token: string): AuthPayload | null {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as AuthPayload;
    if (!payload.address || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Express 中间件：要求请求携带有效 Bearer token，并将 auth 写入 res.locals */
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
