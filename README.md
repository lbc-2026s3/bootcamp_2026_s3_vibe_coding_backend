# bootcamp_2026_s3_vibe_coding_backend

监听并演示 `NFTMarket` 上架 / 成交。

## 准备

1. 启动 `anvil`
2. 部署合约（foundry 目录）：

```bash
forge script script/NFTMarket.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

3. 配置环境变量：

```bash
cp .env.example .env
```

填写 `NFT_MARKET_ADDRESS`。`RPC_URL` 建议用 `ws://127.0.0.1:8545`（监听用）；交易脚本会自动改成 `http://`。

默认卖家 / 买家为 Anvil `#0` / `#1`。

## 运行（两个终端）

```bash
# 终端 1：监听 Listed / Bought
npm run watchNFTMarket

# 终端 2：卖家挂单 + 买家购买
npm run tradeNFTMarket
```

流程：部署后 demo 打款给买家 → 卖家 mint → `safeTransferFrom(..., price)` 上架 → 买家 `transferAndCall` 购买。
