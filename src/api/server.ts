import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { getAddress, isAddress } from "viem";
import { openDatabase, getTransfersForAddress } from "../db/schema.js";
import { createNonceHandler, requireAuth, verifySiweHandler } from "./auth.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 3001);
const dbPath = process.env.DATABASE_PATH ?? "./data/transfers.db";
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
const tokenDecimals = Number(process.env.TOKEN_DECIMALS ?? "18");

const db = openDatabase(dbPath);

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/nonce", createNonceHandler);
app.post("/api/auth/verify", (req, res) => {
  void verifySiweHandler(req, res);
});

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
