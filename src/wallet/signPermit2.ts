/**
 * 离线签署 Uniswap Permit2 SignatureTransfer (PermitTransferFrom)。
 * 不发链上交易；输出 signature，可供 TokenBankPermit2.depositWithPermit2 使用。
 *
 * 用法:
 *   npm run signPermit2 -- <spender> <amount> [deadline]
 *
 * spender 必须是 TokenBankPermit2 合约地址（链上 Permit2 用 msg.sender 校验 spender）。
 * amount 为人可读 TOKEN 数量。
 * nonce 由转账字段 + 密码学随机盐自动生成（keccak256），无需手动传入。
 * deadline 为 unix 秒；缺省为当前时间 + 1 天。
 */
import { randomBytes } from "node:crypto";
import {
  encodeAbiParameters,
  formatUnits,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import { resolveChain } from "../lib/chain.js";

dotenv.config();

/** Permit2 EIP-712：无 version 字段 */
const PERMIT2_DOMAIN_NAME = "Permit2";

const PERMIT_TRANSFER_FROM_TYPES = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

function printUsage(): void {
  console.log(`离线 Permit2 PermitTransferFrom 签名（供 TokenBankPermit2.depositWithPermit2）

用法:
  npm run signPermit2 -- <spender> <amount> [deadline]

参数:
  spender   TokenBankPermit2 合约地址（签名域中的 spender）
  amount    存款数量（人可读 TOKEN）
  deadline  过期 unix 秒（可选，默认 now+86400）

nonce:
  自动生成 = keccak256(owner, spender, token, amount, deadline, chainId, 32字节随机盐)
  绑定本次转账信息 + CSPRNG，碰撞概率可忽略

.env（均必需，无默认值）:
  PRIVATE_KEY            owner 私钥（必须与上链 msg.sender 一致）
  PERMIT2_ADDRESS        Permit2 合约地址
  PERMIT2_TOKEN_ADDRESS  银行接受的 ERC20 地址
  CHAIN_ID               如 11155111（Sepolia）/ 31337（Anvil）
  TOKEN_DECIMALS         如 18
`);
}

/** Permit2 无序 nonce：转账字段 + 32 字节随机盐 → keccak256 → uint256 */
function generateUniqueNonce(params: {
  owner: Address;
  spender: Address;
  token: Address;
  amount: bigint;
  deadline: bigint;
  chainId: number;
}): bigint {
  const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
  return BigInt(
    keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "address owner, address spender, address token, uint256 amount, uint256 deadline, uint256 chainId, bytes32 salt",
        ),
        [
          params.owner,
          params.spender,
          params.token,
          params.amount,
          params.deadline,
          BigInt(params.chainId),
          salt,
        ],
      ),
    ),
  );
}

function requireArg(name: string, value: string | undefined): string {
  if (!value) {
    printUsage();
    throw new Error(`缺少参数: ${name}`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`请在 .env 中设置 ${name}`);
  }
  return value;
}

function loadPrivateKey(): Hex {
  const key = requireEnv("PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("PRIVATE_KEY 格式无效（需要 0x + 64 位十六进制）");
  }
  return key as Hex;
}

function loadChainId(): number {
  const raw = requireEnv("CHAIN_ID");
  const chainId = Number(raw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`CHAIN_ID 无效: ${raw}`);
  }
  return chainId;
}

function loadTokenDecimals(): number {
  const raw = requireEnv("TOKEN_DECIMALS");
  const decimals = Number(raw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`TOKEN_DECIMALS 无效: ${raw}`);
  }
  return decimals;
}

function parseAmount(amountStr: string, decimals: number): bigint {
  try {
    return parseUnits(amountStr, decimals);
  } catch {
    throw new Error(`无效的 amount: ${amountStr}`);
  }
}

function parseCliArgs(argv: string[]): {
  spenderRaw: string | undefined;
  amountRaw: string | undefined;
  deadlineRaw: string | undefined;
  help: boolean;
} {
  const positional: string[] = [];
  let help = false;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`未知选项: ${arg}`);
    }
    positional.push(arg);
  }

  return {
    spenderRaw: positional[0],
    amountRaw: positional[1],
    deadlineRaw: positional[2],
    help,
  };
}

async function main(): Promise<void> {
  const { spenderRaw, amountRaw, deadlineRaw, help } = parseCliArgs(
    process.argv.slice(2),
  );

  if (help || !spenderRaw) {
    printUsage();
    return;
  }

  const spender = getAddress(requireArg("spender", spenderRaw));
  const token = getAddress(requireEnv("PERMIT2_TOKEN_ADDRESS"));
  const permit2 = getAddress(requireEnv("PERMIT2_ADDRESS"));
  const decimals = loadTokenDecimals();
  const amount = parseAmount(requireArg("amount", amountRaw), decimals);
  if (amount <= 0n) {
    throw new Error("amount 必须大于 0");
  }

  const chainId = loadChainId();
  const chain = resolveChain(chainId);
  const privateKey = loadPrivateKey();
  const account = privateKeyToAccount(privateKey);
  const owner = account.address;

  const nowSec = Math.floor(Date.now() / 1000);
  let deadline: bigint;
  if (deadlineRaw === undefined) {
    deadline = BigInt(nowSec + 86_400);
  } else {
    if (!/^\d+$/.test(deadlineRaw)) {
      throw new Error(`无效的 deadline（需 unix 秒）: ${deadlineRaw}`);
    }
    deadline = BigInt(deadlineRaw);
    if (deadline <= BigInt(nowSec)) {
      throw new Error(`deadline 已过期或过近: ${deadlineRaw}`);
    }
  }

  const nonce = generateUniqueNonce({
    owner,
    spender,
    token,
    amount,
    deadline,
    chainId,
  });

  // Permit2 domain: EIP712Domain(string name,uint256 chainId,address verifyingContract) — 无 version
  const domain = {
    name: PERMIT2_DOMAIN_NAME,
    chainId,
    verifyingContract: permit2,
  };

  const message = {
    permitted: {
      token,
      amount,
    },
    spender,
    nonce,
    deadline,
  };

  const signature = await account.signTypedData({
    domain,
    types: PERMIT_TRANSFER_FROM_TYPES,
    primaryType: "PermitTransferFrom",
    message,
  });

  console.log(`网络: ${chain.name} (chainId=${chain.id})`);
  console.log(`Permit2: ${permit2}`);
  console.log(`Token: ${token}`);
  console.log(`Owner: ${owner}`);
  console.log(`Spender (TokenBankPermit2): ${spender}`);
  console.log(`Amount: ${formatUnits(amount, decimals)} (raw=${amount.toString()})`);
  console.log(`Nonce: ${nonce.toString()} (auto)`);
  console.log(`Deadline: ${deadline.toString()}`);
  console.log(`Domain: name=${PERMIT2_DOMAIN_NAME} (no version)`);
  console.log("---");
  console.log(
    JSON.stringify(
      {
        owner,
        permit: {
          permitted: {
            token,
            amount: amount.toString(),
          },
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
        spender,
        signature,
      },
      null,
      2,
    ),
  );
  console.log("---");
  console.log(
    `前置条件: owner 需已对 Permit2 授权 token（通常一次性 max approve）:\n` +
      `  cast send ${token} "approve(address,uint256)" ${permit2} ` +
      `0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff ` +
      `--private-key <OWNER_KEY> --rpc-url <RPC_URL>`,
  );
  console.log(
    `cast 调用 depositWithPermit2 示例:\n` +
      `  cast send ${spender} ` +
      `"depositWithPermit2(((address,uint256),uint256,uint256),bytes)" ` +
      `"((${token},${amount.toString()}),${nonce.toString()},${deadline.toString()})" ` +
      `${signature} --private-key <OWNER_KEY> --rpc-url <RPC_URL>`,
  );
}

main().catch((err) => {
  console.error("错误:", err instanceof Error ? err.message : err);
  process.exit(1);
});
