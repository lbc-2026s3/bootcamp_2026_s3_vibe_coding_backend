# bootcamp_2026_s3_vibe_coding_backend

后端服务：NFTMarket 事件监听、MyTokenERC1363 转账索引、Express REST API（SIWE 鉴权）。

## 准备

1. 部署 MyTokenERC1363（foundry 目录）：

```bash
forge script script/MyTokenERC1363.s.sol --rpc-url <RPC> --broadcast
```

2. 配置环境变量：

```bash
cp .env.example .env
```

填写 `TOKEN_ADDRESS`、`START_BLOCK`（部署区块）、`RPC_URL`、`CHAIN_ID` 等。

Sepolia 部署示例（见 `deployments/MyTokenERC1363/MyTokenERC1363_11155111.json`）：

- `TOKEN_ADDRESS=0xc2B645e76dccecD36c833A621e115F41a2C0Bc3c`
- `START_BLOCK=11672253`
- `CHAIN_ID=11155111`

## ERC20 转账索引 + API

需要两个终端：

```bash
# 终端 1：索引 Transfer 事件并写入 SQLite
npm run indexERC20

# 终端 2：Express API（SIWE + 转账查询）
npm run server
```

### API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/api/auth/nonce` | 获取 SIWE nonce |
| POST | `/api/auth/verify` | 验证 SIWE 签名，返回 token |
| GET | `/api/transfers/:address` | 查询地址转账（需 `Authorization: Bearer <token>`，且地址须与登录地址一致） |

数据保存在 `DATABASE_PATH`（默认 `./data/transfers.db`）。

## NFTMarket 演示

1. 启动 `anvil`
2. 部署 `NFTMarket.s.sol`
3. 填写 `NFT_MARKET_ADDRESS`

```bash
npm run watchNFTMarket   # 监听 Listed / Bought
npm run tradeNFTMarket   # 演示挂单与购买
```
