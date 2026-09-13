/**
 * 预测指定地址下一次 CREATE 部署的合约地址。
 *
 * CREATE (0xF0) 公式（Yellow Paper / evm.codes）:
 *   address = keccak256(RLP([sender, nonce]))[12:]
 * nonce=0 时 RLP 编码为空字节串 0x80，不是 0x00。
 *
 * 用法:
 *   npm run predictCreate -- <deployer>
 *   npm run predictCreate -- <deployer> --nonce <n>
 *   npm run predictCreate -- <deployer> --count <n>
 *
 * 文档: https://www.evm.codes/?fork=osaka#f0
 */
import {
  createPublicClient,
  getAddress,
  keccak256,
  toBytes,
  toRlp,
  type Address,
} from "viem";
import dotenv from "dotenv";
import { createTransport, httpRpcUrl, resolveChain } from "../lib/chain.js";

dotenv.config();

function printUsage(): void {
  console.log(`预测指定地址下一次 CREATE 部署的合约地址

CREATE (0xF0): address = keccak256(RLP([sender, nonce])) 的后 20 字节
文档: https://www.evm.codes/?fork=osaka#f0

用法:
  npm run predictCreate -- <deployer>
  npm run predictCreate -- <deployer> --nonce <n>
  npm run predictCreate -- <deployer> --count <n>

参数:
  deployer  部署者地址（EOA 或合约）
  --nonce   手动指定将用于 CREATE 的 nonce（可选；不传则 eth_getTransactionCount）
  --count   连续预测接下来 N 个 CREATE 地址（默认 1）

.env:
  RPC_URL   读链上 nonce 时使用（默认 http://127.0.0.1:8545；--nonce 时可省略）
  CHAIN_ID  默认 31337（Anvil）；Sepolia 为 11155111
`);
}

function parseNonNegativeInt(name: string, raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} 需要非负整数`);
  }
  return BigInt(raw);
}

function parseCliArgs(argv: string[]): {
  deployerRaw: string | undefined;
  nonceOverride: bigint | undefined;
  count: number;
  help: boolean;
} {
  const positional: string[] = [];
  let nonceOverride: bigint | undefined;
  let count = 1;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--nonce") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--nonce 需要非负整数");
      }
      nonceOverride = parseNonNegativeInt("--nonce", next);
      continue;
    }
    if (arg === "--count") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--count 需要正整数");
      }
      const parsed = parseNonNegativeInt("--count", next);
      if (parsed < 1n || parsed > 1000n) {
        throw new Error("--count 范围为 1..1000");
      }
      count = Number(parsed);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`未知选项: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error(
      `多余参数: ${positional.slice(1).join(" ")}；nonce 请用 --nonce`,
    );
  }

  return {
    deployerRaw: positional[0],
    nonceOverride,
    count,
    help,
  };
}

/**
 * CREATE 地址：keccak256(RLP([sender, nonce])) 取后 20 字节。
 * nonce=0 按 RLP 规则编码为空字节串（0x80），不是单字节 0x00。
 */
function predictCreateAddress(from: Address, nonce: bigint): Address {
  const senderBytes = toBytes(getAddress(from));
  let nonceBytes = toBytes(nonce);
  if (nonceBytes[0] === 0) {
    nonceBytes = new Uint8Array([]);
  }
  const hash = keccak256(toRlp([senderBytes, nonceBytes]));
  return getAddress(`0x${hash.slice(26)}`);
}

async function main(): Promise<void> {
  const { deployerRaw, nonceOverride, count, help } = parseCliArgs(
    process.argv.slice(2),
  );

  if (help || !deployerRaw) {
    printUsage();
    if (!help && !deployerRaw) {
      throw new Error("缺少参数: deployer");
    }
    return;
  }

  const deployer = getAddress(deployerRaw);

  let nonce: bigint;

  if (nonceOverride !== undefined) {
    nonce = nonceOverride;
    console.log("模式: 离线（使用 --nonce，不读链）");
  } else {
    const rpcUrl = httpRpcUrl(process.env.RPC_URL ?? "http://127.0.0.1:8545");
    const chainId = Number(process.env.CHAIN_ID ?? "31337");
    const chain = resolveChain(chainId);
    const publicClient = createPublicClient({
      chain,
      transport: createTransport(rpcUrl),
    });

    const rpcChainId = await publicClient.getChainId();
    if (rpcChainId !== chainId) {
      throw new Error(
        `CHAIN_ID=${chainId} 与 RPC 实际 chainId=${rpcChainId} 不一致`,
      );
    }

    nonce = BigInt(
      await publicClient.getTransactionCount({
        address: deployer,
        blockTag: "pending",
      }),
    );
    console.log("模式: 读链上 nonce 后按 CREATE 公式预测");
    console.log(`网络: ${chain.name} (chainId=${chain.id})`);
    console.log(`RPC:  ${rpcUrl}`);
  }

  console.log(`Deployer: ${deployer}`);
  console.log(`公式: keccak256(RLP([sender, nonce]))[12:]`);
  console.log("---");

  const predicted: { nonce: string; address: Address }[] = [];
  for (let i = 0; i < count; i++) {
    const usedNonce = nonce + BigInt(i);
    const address = predictCreateAddress(deployer, usedNonce);
    predicted.push({ nonce: usedNonce.toString(), address });
    console.log(`nonce=${usedNonce.toString()}  ->  ${address}`);
  }

  console.log("---");
  console.log(JSON.stringify({ deployer, predicted }, null, 2));
}

main().catch((err) => {
  console.error("错误:", err instanceof Error ? err.message : err);
  process.exit(1);
});
