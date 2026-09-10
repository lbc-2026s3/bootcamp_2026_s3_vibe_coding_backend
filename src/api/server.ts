/**
 * Express API 服务入口。
 *
 * 提供：
 * - SIWE 登录（nonce / verify）
 * - 已登录用户查询自己的 ERC-20 转账记录
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { getAddress, isAddress } from "viem";
import { openDatabase, getTransfersForAddress } from "../db/schema.js";
import { createNonceHandler, requireAuth, verifySiweHandler } from "./auth.js";

dotenv.config();

const app = express();

// 服务监听端口，默认 3001
const port = Number(process.env.PORT ?? 3001);
// SQLite 数据库路径
const dbPath = process.env.DATABASE_PATH ?? "./data/transfers.db";
// 允许跨域请求的前端地址；未配置时默认本地 Next.js 开发服务器
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
// 代币精度，用于前端展示 raw value
const tokenDecimals = Number(process.env.TOKEN_DECIMALS ?? "18");

const db = openDatabase(dbPath);

// 只允许指定 origin 的浏览器请求，并允许携带凭证（如 Cookie / Authorization）
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
app.use(express.json());

/** 健康检查，供部署探活使用 */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** SIWE 登录：获取 nonce 与 sessionId */
app.get("/api/auth/nonce", createNonceHandler);
/** SIWE 登录：验证签名并返回 token */
app.post("/api/auth/verify", (req, res) => {
  // void：标记「故意不 await 此 Promise」，消除 no-floating-promises 告警；Express 本身也不会 await handler
  void verifySiweHandler(req, res);
});

/**
 * 查询指定地址的 ERC-20 转账记录。
 * 需要 Bearer token；且只能查询当前登录地址的数据。
 */
app.get("/api/transfers/:address", requireAuth, (req, res) => {
  const auth = res.locals.auth as { address: string };
  const addressParam = req.params.address;
  if (typeof addressParam !== "string" || !isAddress(addressParam)) {
    res.status(400).json({ error: "无效地址" });
    return;
  }

  const requested = getAddress(addressParam).toLowerCase();
  if (requested !== auth.address) {
    res.status(403).json({ error: "只能查询当前登录地址的转账记录" });
    return;
  }

  const rows = getTransfersForAddress(db, requested);
  const transfers = rows.map((row) => ({
    id: row.id,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    blockNumber: row.block_number,
    timestamp: row.block_timestamp,
    from: row.from_address,
    to: row.to_address,
    value: row.value,
    direction:
      row.to_address === requested
        ? "in"
        : row.from_address === requested
          ? "out"
          : "unknown",
  }));

  res.json({
    address: requested,
    tokenDecimals,
    transfers,
  });
});

app.listen(port, () => {
  console.log(`API 服务已启动: http://localhost:${port}`);
  console.log(`CORS origin: ${corsOrigin}`);
  console.log(`数据库: ${dbPath}`);
});
