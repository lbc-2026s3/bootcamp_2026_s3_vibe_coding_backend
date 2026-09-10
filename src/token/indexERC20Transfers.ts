import {
  createPublicClient,
  getAddress,
  parseAbiItem,
  type Address,
  type Log,
} from "viem";
import dotenv from "dotenv";
import MyTokenAbiJson from "../abis/MyTokenERC1363.json" with { type: "json" };
import { openDatabase, insertTransfer, getSyncState, setSyncState } from "../db/schema.js";
import { createTransport, httpRpcUrl, resolveChain } from "../lib/chain.js";

dotenv.config();

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const SYNC_LAST_BLOCK_KEY = "last_indexed_block";

type TransferArgs = {
  from?: Address;
  to?: Address;
  value?: bigint;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`请在 .env 中设置 ${name}`);
  return value;
}

function transferId(txHash: string, logIndex: number): string {
  return `${txHash}-${logIndex}`;
}

async function persistLogs(
  db: ReturnType<typeof openDatabase>,
  logs: Log[],
  tokenAddress: Address,
  client: ReturnType<typeof createPublicClient>,
): Promise<number> {
  let inserted = 0;

  for (const log of logs) {
    const args = (log as unknown as { args: TransferArgs }).args;
    if (!args.from || !args.to || args.value === undefined) continue;

    const block = await client.getBlock({ blockNumber: log.blockNumber! });
    const ok = insertTransfer(db, {
      id: transferId(log.transactionHash!, log.logIndex!),
      tx_hash: log.transactionHash!,
      log_index: log.logIndex!,
      block_number: Number(log.blockNumber!),
      block_timestamp: Number(block.timestamp),
      from_address: getAddress(args.from).toLowerCase(),
      to_address: getAddress(args.to).toLowerCase(),
      value: args.value.toString(),
      token_address: tokenAddress.toLowerCase(),
    });
    if (ok) inserted += 1;
  }

  return inserted;
}

async function backfill(
  db: ReturnType<typeof openDatabase>,
  client: ReturnType<typeof createPublicClient>,
  tokenAddress: Address,
  fromBlock: bigint,
): Promise<void> {
  const latest = await client.getBlockNumber();
  const saved = getSyncState(db, SYNC_LAST_BLOCK_KEY);
  let cursor = saved ? BigInt(saved) + 1n : fromBlock;

  if (cursor > latest) {
    console.log(`已同步至最新区块 ${latest}`);
    return;
  }

  const chunkSize = 2_000n;
  console.log(`回填 Transfer 事件：${cursor} → ${latest}`);

  while (cursor <= latest) {
    const toBlock = cursor + chunkSize - 1n > latest ? latest : cursor + chunkSize - 1n;
    const logs = await client.getLogs({
      address: tokenAddress,
      event: TRANSFER_EVENT,
      fromBlock: cursor,
      toBlock,
    });

    const inserted = await persistLogs(db, logs, tokenAddress, client);
    setSyncState(db, SYNC_LAST_BLOCK_KEY, toBlock.toString());
    console.log(`  区块 ${cursor}-${toBlock}: ${logs.length} 条日志, 新增 ${inserted} 条`);
    cursor = toBlock + 1n;
  }
}

const main = async () => {
  const rpcUrl = requireEnv("RPC_URL");
  const tokenAddressRaw = requireEnv("TOKEN_ADDRESS");
  const startBlockRaw = requireEnv("START_BLOCK");
  const chainId = Number(process.env.CHAIN_ID ?? "11155111");
  const dbPath = process.env.DATABASE_PATH ?? "./data/transfers.db";

  const tokenAddress = getAddress(tokenAddressRaw);
  const startBlock = BigInt(startBlockRaw);
  const chain = resolveChain(chainId);

  const db = openDatabase(dbPath);
  const httpClient = createPublicClient({
    chain,
    transport: createTransport(httpRpcUrl(rpcUrl)),
  });

  console.log(`索引 MyTokenERC1363 Transfer @ ${tokenAddress}`);
  console.log(`链: ${chain.name} (${chain.id})`);
  console.log(`数据库: ${dbPath}`);
  console.log(`起始区块: ${startBlock}\n`);

  await backfill(db, httpClient, tokenAddress, startBlock);

  const watchClient = createPublicClient({
    chain,
    transport: createTransport(rpcUrl),
  });

  console.log("开始实时监听 Transfer 事件...\n");

  const unwatch = watchClient.watchContractEvent({
    address: tokenAddress,
    abi: MyTokenAbiJson,
    eventName: "Transfer",
    onLogs: async (logs) => {
      const inserted = await persistLogs(db, logs, tokenAddress, httpClient);
      if (logs.length > 0) {
        const lastBlock = logs[logs.length - 1]!.blockNumber!;
        setSyncState(db, SYNC_LAST_BLOCK_KEY, lastBlock.toString());
      }
      for (const log of logs) {
        const { from, to, value } = (log as unknown as { args: TransferArgs }).args;
        console.log("—— Transfer ——");
        console.log(`  from  : ${from}`);
        console.log(`  to    : ${to}`);
        console.log(`  value : ${value?.toString() ?? "?"}`);
        console.log(`  tx    : ${log.transactionHash}`);
        console.log(`  block : ${log.blockNumber}`);
        console.log("");
      }
      if (inserted > 0) {
        console.log(`已写入 ${inserted} 条新转账记录`);
      }
    },
  });

  process.on("SIGINT", () => {
    console.log("\n停止索引...");
    unwatch();
    db.close();
    process.exit(0);
  });
};

main().catch((error) => {
  console.error("索引失败:", error);
  process.exit(1);
});
