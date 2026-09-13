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

## 命令行钱包（EIP-1559）

从 `.env` 加载 `PRIVATE_KEY`、`TOKEN_ADDRESS`、`RPC_URL`、`CHAIN_ID`，按参数构建并发送交易。默认 Anvil（`CHAIN_ID=31337`）。

先启动 anvil 并部署 MyTokenERC1363：

```bash
anvil
# foundry 目录
forge script script/MyTokenERC1363.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

将部署地址写入 `.env` 的 `TOKEN_ADDRESS`，然后：

```bash
# ETH 转账
npm run wallet -- eth 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0.1

# ERC20（MyTokenERC1363）转账
npm run wallet -- erc20 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 100
```

## 离线 EIP-2612 Permit 签名（MyTokenERC2612Permit）

不发链上交易，用 owner 私钥签 EIP-712 Permit，输出 `v/r/s`，可供 `token.permit` 或 `TokenBankERC2612.permitDeposit` 使用。

```bash
# foundry 目录部署 token
forge script script/MyTokenERC2612Permit.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

在 `.env` 填写 `TOKEN2612_ADDRESS`，然后：

```bash
# 读链上 nonce 后离线签名（spender, amount, 可选 deadline unix 秒）
npm run signPermit -- 0xTokenBankAddress 100

# 完全离线：手动指定 nonce，不访问 RPC
npm run signPermit -- 0xTokenBankAddress 100 --nonce 0
```

## 离线 Permit2 签名（TokenBankPermit2）

不发链上交易，用 owner 私钥签 Uniswap Permit2 `PermitTransferFrom`，输出 `signature`，可供 `TokenBankPermit2.depositWithPermit2` 使用。

```bash
# foundry 目录部署 MyTokenV1 + TokenBankPermit2
forge script script/TokenBankPermit2.s.sol --rpc-url <SEPOLIA_RPC> --broadcast
```

在 `.env` 填写（均必需，脚本无默认值）：

- `PRIVATE_KEY`
- `PERMIT2_ADDRESS`（Sepolia: `0x000000000022D473030F116dDEE9F6B43aC78BA3`）
- `PERMIT2_TOKEN_ADDRESS`（部署得到的 MyTokenV1）
- `CHAIN_ID=11155111`
- `TOKEN_DECIMALS=18`

```bash
# spender=TokenBankPermit2, amount, 可选 deadline；nonce 自动生成
npm run signPermit2 -- 0xTokenBankPermit2Address 100

# 指定 deadline（unix 秒）
npm run signPermit2 -- 0xTokenBankPermit2Address 100 1893456000
```

上链前 owner 需已对 Permit2 做 ERC20 `approve`（通常一次性 max）。签名中的 spender 必须是银行地址，且用同一把 `PRIVATE_KEY` 调用 `depositWithPermit2`。

## 预测下一次 CREATE 合约地址

`CREATE`（opcode `0xF0`）部署地址只由发送方与其 nonce 决定：

```
address = keccak256(RLP([sender, nonce]))[12:]
```

nonce=0 时 RLP 编码为空字节串 `0x80`（不是 `0x00`）。读链时用 `eth_getTransactionCount` 作为即将用于 CREATE 的 nonce。参考 [evm.codes CREATE](https://www.evm.codes/?fork=osaka#f0)。

```bash
# 从 RPC 读 deployer 当前 nonce，预测下一个合约地址
npm run predictCreate -- 0xYourDeployerAddress

# 完全离线：手动指定 nonce
npm run predictCreate -- 0xYourDeployerAddress --nonce 7

# 连续预测接下来 5 次 CREATE 地址
npm run predictCreate -- 0xYourDeployerAddress --count 5
```

`.env` 的 `RPC_URL` / `CHAIN_ID` 与钱包脚本相同；使用 `--nonce` 时可不连 RPC。这与 `CREATE2` 无关（`CREATE2` 还依赖 salt 与 init code hash）。

## NFTMarket 演示

1. 启动 `anvil`
2. 部署 `NFTMarket.s.sol`
3. 填写 `NFT_MARKET_ADDRESS`

```bash
npm run watchNFTMarket   # 监听 Listed / Bought
npm run tradeNFTMarket   # 演示挂单与购买
```
