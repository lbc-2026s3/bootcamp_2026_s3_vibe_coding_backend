/**
 * 监听 EventLab 事件，并用 forge inspect 取出的 ABI 解码后打印。
 *
 * 值类型 indexed 参数解码后仍是原值。
 * string / bytes / 数组 / 结构体 indexed 参数解码后是 Keccak-256，明文在非 indexed 参数里。
 *
 * 用法:
 *   npm run watchEventLab
 *
 * .env:
 *   RPC_URL              必填，监听建议 ws://
 *   CHAIN_ID             默认 31337
 *   EVENT_LAB_ADDRESS    必填
 *   FOUNDRY_PROJECT      必填，foundry 工程根目录（forge inspect --json 在此执行）
 *   EVENT_LAB_CONTRACT   可选，默认 EventLab
 *   EVENT_LAB_FROM_BLOCK 可选，设置后先回填该区块至今的历史日志
 */
import { execFileSync } from "node:child_process";
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  type Abi,
  type AbiEvent,
  type Address,
  type Log,
} from "viem";
import dotenv from "dotenv";
import { createTransport, resolveChain } from "../lib/chain.js";

dotenv.config();

type DecodedArgs = Record<string, unknown> | readonly unknown[];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`请在 .env 中设置 ${name}`);
  return value;
}

/** string、bytes、数组、结构体被 indexed 时，topic 存的是哈希。bytes32 是值类型，不算在内。 */
function isHashedWhenIndexed(solType: string): boolean {
  if (solType === "string" || solType === "bytes") return true;
  if (solType.includes("[")) return true;
  if (solType.startsWith("tuple")) return true;
  return false;
}

function loadAbi(projectDir: string, contractName: string): Abi {
  let raw: string;
  try {
    raw = execFileSync("forge", ["inspect", contractName, "abi", "--json"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr?: Buffer | string }).stderr ?? "")
        : "";
    throw new Error(
      `forge inspect ${contractName} abi 失败。确认已安装 forge，且 FOUNDRY_PROJECT 指向 foundry 工程。\n${stderr}`,
    );
  }
  return JSON.parse(raw) as Abi;
}

function findEvent(abi: Abi, eventName: string): AbiEvent | undefined {
  return abi.find((item): item is AbiEvent => item.type === "event" && item.name === eventName);
}

function stringify(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean" || value == null) return String(value);
  if (typeof value === "string") return value.startsWith("0x") ? value : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stringify(item)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, nested]) => `${key}: ${stringify(nested)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  return String(value);
}

function readArg(args: DecodedArgs, name: string | undefined, index: number): unknown {
  if (Array.isArray(args)) return args[index];
  if (name && typeof args === "object" && args !== null && name in args) {
    return (args as Record<string, unknown>)[name];
  }
  return undefined;
}

function printLog(abi: Abi, log: Log): void {
  const decoded = decodeEventLog({
    abi,
    data: log.data,
    topics: log.topics,
  });
  const eventName = decoded.eventName;
  if (!eventName) {
    console.log("—— 未识别的日志 ——");
    console.log(`  tx    : ${log.transactionHash}`);
    console.log(`  topics: ${log.topics.join(", ")}`);
    console.log("");
    return;
  }
  const args = (decoded.args ?? {}) as DecodedArgs;
  const event = findEvent(abi, eventName);

  console.log(`—— ${eventName} ——`);
  console.log(`  tx       : ${log.transactionHash}`);
  console.log(`  block    : ${log.blockNumber}`);
  console.log(`  logIndex : ${log.logIndex}`);

  if (!event) {
    console.log(`  args     : ${stringify(args)}`);
    console.log("");
    return;
  }

  let topicIndex = event.anonymous ? 0 : 1;
  event.inputs.forEach((input, index) => {
    const value = readArg(args, input.name, index);
    const hashed = Boolean(input.indexed) && isHashedWhenIndexed(input.type);
    const where = input.indexed ? `topic[${topicIndex}]` : "data";
    console.log(`  ${input.name || "(unnamed)"} (${input.type}${input.indexed ? ", indexed" : ""}) @ ${where}`);
    console.log(`    ${stringify(value)}`);
    if (hashed) {
      console.log("    这是 Keccak-256，不是明文。过滤器只能拿这个哈希去匹配 topic。");
    }
    if (input.indexed) topicIndex += 1;
  });
  console.log("");
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("RPC_URL");
  const contractAddress: Address = getAddress(requireEnv("EVENT_LAB_ADDRESS"));
  const projectDir = requireEnv("FOUNDRY_PROJECT");
  const contractName = process.env.EVENT_LAB_CONTRACT ?? "EventLab";
  const chainId = Number(process.env.CHAIN_ID ?? "31337");
  const chain = resolveChain(chainId);
  const fromBlockRaw = process.env.EVENT_LAB_FROM_BLOCK;
  const fromBlock = fromBlockRaw ? BigInt(fromBlockRaw) : undefined;

  const abi = loadAbi(projectDir, contractName);
  const eventCount = abi.filter((item) => item.type === "event").length;

  const publicClient = createPublicClient({
    chain,
    transport: createTransport(rpcUrl),
  });

  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== chainId) {
    throw new Error(`CHAIN_ID=${chainId} 与 RPC 实际 chainId=${rpcChainId} 不一致`);
  }

  console.log(`监听 ${contractName} @ ${contractAddress}`);
  console.log(`网络: ${chain.name} (chainId=${chain.id})`);
  console.log(`RPC:  ${rpcUrl}`);
  console.log(`ABI:  forge inspect ${contractName} abi --json  （${eventCount} 个事件，工程 ${projectDir}）`);
  console.log("");

  const seen = new Set<string>();
  const handle = (logs: Log[]) => {
    for (const log of logs) {
      const id = `${log.transactionHash}-${log.logIndex}`;
      if (log.removed) {
        seen.delete(id);
        console.log(`回滚 ${id}\n`);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        printLog(abi, log);
      } catch (error) {
        console.error(`解码失败 ${id}:`, error instanceof Error ? error.message : error);
      }
    }
  };

  let watchFromBlock: bigint | undefined;
  if (fromBlock !== undefined) {
    const head = await publicClient.getBlockNumber();
    const historical = await publicClient.getLogs({
      address: contractAddress,
      fromBlock,
      toBlock: head,
    });
    console.log(`回填 ${historical.length} 条日志（区块 ${fromBlock.toString()} 到 ${head.toString()}）\n`);
    handle(historical);
    watchFromBlock = head;
  }

  const unwatch = publicClient.watchContractEvent({
    address: contractAddress,
    abi,
    fromBlock: watchFromBlock,
    onLogs: (logs) => handle(logs as Log[]),
    onError: (error) => {
      console.error("监听中断:", error);
    },
  });

  console.log("等待新事件... Ctrl+C 退出\n");

  process.on("SIGINT", () => {
    console.log("\n停止监听...");
    unwatch();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("发生错误:", error instanceof Error ? error.message : error);
  process.exit(1);
});
