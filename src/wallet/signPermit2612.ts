/**
 * 离线签署 MyTokenERC2612Permit (EIP-2612) Permit。
 * 不发链上交易；输出 v/r/s，可供 token.permit 或 TokenBankERC2612.permitDeposit 使用。
 *
 * 用法:
 *   npm run signPermit -- <spender> <amount> [deadline]
 *
 * amount 为人可读 TOKEN 数量（默认 18 位小数）。
 * deadline 为 unix 秒；缺省为当前时间 + 1 天。
 * 可用 --nonce <n> 跳过链上读取（完全离线）。
 */
import {
  createPublicClient,
  formatUnits,
  getAddress,
  parseUnits,
  parseSignature,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import MyTokenAbiJson from "../abis/MyTokenERC2612Permit.json" with { type: "json" };
import { createTransport, httpRpcUrl, resolveChain } from "../lib/chain.js";

dotenv.config();

const MyTokenAbi = MyTokenAbiJson as Abi;

/** Anvil account#0 — 仅本地缺省私钥时回退 */
const ANVIL_ACCOUNT0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

/** OpenZeppelin ERC20Permit 构造函数传入的 EIP-712 name / version */
const PERMIT_DOMAIN_NAME = "MyToken2612";
const PERMIT_DOMAIN_VERSION = "1";

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

function printUsage(): void {
  console.log(`离线 EIP-2612 Permit 签名（MyTokenERC2612Permit）

用法:
  npm run signPermit -- <spender> <amount> [deadline]
  npm run signPermit -- <spender> <amount> [deadline] --nonce <n>

参数:
  spender   被授权地址（如 TokenBankERC2612）
  amount    授权数量（人可读 TOKEN）
  deadline  过期 unix 秒（可选，默认 now+86400）
  --nonce   手动指定 nonce（可选；不传则从链上读 nonces(owner)）

.env:
  PRIVATE_KEY           owner 私钥（可缺省，本地回退 Anvil #0）
  TOKEN2612_ADDRESS     MyTokenERC2612Permit 合约地址（必需）
  RPC_URL               默认 http://127.0.0.1:8545（提供 --nonce 时可省略）
  CHAIN_ID              默认 31337（Anvil）
  TOKEN_DECIMALS        默认 18
`);
}

function requireArg(name: string, value: string | undefined): string {
  if (!value) {
    printUsage();
    throw new Error(`缺少参数: ${name}`);
  }
  return value;
}

function loadPrivateKey(chainId: number): Hex {
  const fromEnv = process.env.PRIVATE_KEY ?? process.env.SELLER_PRIVATE_KEY;
  const key = fromEnv ?? (chainId === 31337 ? ANVIL_ACCOUNT0_KEY : undefined);
  if (!key) {
    throw new Error("请在 .env 中设置 PRIVATE_KEY（非 Anvil 网络不可省略）");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("PRIVATE_KEY 格式无效（需要 0x + 64 位十六进制）");
  }
  return key as Hex;
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
  nonceOverride: bigint | undefined;
  help: boolean;
} {
  const positional: string[] = [];
  let nonceOverride: bigint | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--nonce") {
      const next = argv[++i];
      if (next === undefined || !/^\d+$/.test(next)) {
        throw new Error("--nonce 需要非负整数");
      }
      nonceOverride = BigInt(next);
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
    nonceOverride,
    help,
  };
}

async function main(): Promise<void> {
  const { spenderRaw, amountRaw, deadlineRaw, nonceOverride, help } =
    parseCliArgs(process.argv.slice(2));

  if (help || !spenderRaw) {
    printUsage();
    return;
  }

  const tokenAddressRaw = process.env.TOKEN2612_ADDRESS;
  if (!tokenAddressRaw) {
    throw new Error(
      "请在 .env 中设置 TOKEN2612_ADDRESS（MyTokenERC2612Permit 部署地址）",
    );
  }

  const spender = getAddress(requireArg("spender", spenderRaw));
  const token = getAddress(tokenAddressRaw);
  const decimalsRaw = process.env.TOKEN_DECIMALS ?? "18";
  const decimals = Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`TOKEN_DECIMALS 无效: ${decimalsRaw}`);
  }

  const value = parseAmount(requireArg("amount", amountRaw), decimals);
  const chainId = Number(process.env.CHAIN_ID ?? "31337");
  const chain = resolveChain(chainId);
  const privateKey = loadPrivateKey(chainId);
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

  let nonce: bigint;
  let domainName = PERMIT_DOMAIN_NAME;

  if (nonceOverride !== undefined) {
    nonce = nonceOverride;
    console.log("模式: 完全离线（使用 --nonce，不读链）");
  } else {
    const rpcUrl = httpRpcUrl(process.env.RPC_URL ?? "http://127.0.0.1:8545");
    const publicClient = createPublicClient({
      chain,
      transport: createTransport(rpcUrl),
    });

    const [onchainNonce, onchainName] = await Promise.all([
      publicClient.readContract({
        address: token,
        abi: MyTokenAbi,
        functionName: "nonces",
        args: [owner],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: token,
        abi: MyTokenAbi,
        functionName: "name",
      }) as Promise<string>,
    ]);

    nonce = onchainNonce;
    domainName = onchainName;
    console.log(`模式: 离线签名（nonce 从链上读取）`);
    console.log(`RPC:  ${rpcUrl}`);
  }

  const domain = {
    name: domainName,
    version: PERMIT_DOMAIN_VERSION,
    chainId,
    verifyingContract: token,
  };

  const message = {
    owner,
    spender,
    value,
    nonce,
    deadline,
  };

  const signature = await account.signTypedData({
    domain,
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message,
  });

  const { r, s, v, yParity } = parseSignature(signature);
  // ERC-2612 / OZ permit 需要 v = 27 或 28（兼容仅返回 yParity 的情况）
  const vNum = v !== undefined ? Number(v) : 27 + yParity;

  console.log(`网络: ${chain.name} (chainId=${chain.id})`);
  console.log(`Token: ${token}`);
  console.log(`Owner: ${owner}`);
  console.log(`Spender: ${spender}`);
  console.log(`Value: ${formatUnits(value, decimals)} (raw=${value.toString()})`);
  console.log(`Nonce: ${nonce.toString()}`);
  console.log(`Deadline: ${deadline.toString()}`);
  console.log(`Domain: name=${domainName} version=${PERMIT_DOMAIN_VERSION}`);
  console.log("---");
  console.log(
    JSON.stringify(
      {
        owner,
        spender,
        value: value.toString(),
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        v: vNum,
        r,
        s,
        signature,
      },
      null,
      2,
    ),
  );
  console.log("---");
  console.log(
    `cast 调用 permitDeposit 示例:\n` +
      `  cast send <BANK> "permitDeposit(uint256,uint256,uint8,bytes32,bytes32)" ` +
      `${value.toString()} ${deadline.toString()} ${vNum} ${r} ${s} --private-key <OWNER_KEY>`,
  );
}

main().catch((err) => {
  console.error("错误:", err instanceof Error ? err.message : err);
  process.exit(1);
});
