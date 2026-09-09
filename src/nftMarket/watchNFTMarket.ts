import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  webSocket,
  type Abi,
  type Address,
  type Transport,
} from "viem";
import { foundry } from "viem/chains";
import dotenv from "dotenv";
import NFTMarketAbiJson from "../abis/NFTMarket.json" with { type: "json" };

dotenv.config();

const NFTMarketAbi = NFTMarketAbiJson as Abi;

function createTransport(rpcUrl: string): Transport {
  if (rpcUrl.startsWith("ws://") || rpcUrl.startsWith("wss://")) {
    return webSocket(rpcUrl);
  }
  return http(rpcUrl);
}

type ListedArgs = {
  tokenId?: bigint;
  seller?: Address;
  price?: bigint;
};

type BoughtArgs = {
  tokenId?: bigint;
  buyer?: Address;
  seller?: Address;
  price?: bigint;
};

const main = async () => {
  const rpcUrl = process.env.RPC_URL;
  const marketAddressRaw = process.env.NFT_MARKET_ADDRESS;

  if (!rpcUrl) {
    throw new Error("请在 .env 中设置 RPC_URL（例如 ws://127.0.0.1:8545）");
  }
  if (!marketAddressRaw) {
    throw new Error("请在 .env 中设置 NFT_MARKET_ADDRESS");
  }

  const marketAddress: Address = getAddress(marketAddressRaw);

  const publicClient = createPublicClient({
    chain: foundry,
    transport: createTransport(rpcUrl),
  });

  console.log(`监听 NFTMarket @ ${marketAddress}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log("等待 Listed / Bought 事件...\n");

  const unwatchListed = publicClient.watchContractEvent({
    address: marketAddress,
    abi: NFTMarketAbi,
    eventName: "Listed",
    onLogs: (logs) => {
      for (const log of logs) {
        const { tokenId, seller, price } = (log as unknown as { args: ListedArgs }).args;
        console.log("—— 上架 Listed ——");
        console.log(`  tokenId : ${tokenId}`);
        console.log(`  seller  : ${seller}`);
        console.log(`  price   : ${price !== undefined ? formatEther(price) : "?"} TOKEN`);
        console.log(`  tx      : ${log.transactionHash}`);
        console.log(`  block   : ${log.blockNumber}`);
        console.log("");
      }
    },
  });

  const unwatchBought = publicClient.watchContractEvent({
    address: marketAddress,
    abi: NFTMarketAbi,
    eventName: "Bought",
    onLogs: (logs) => {
      for (const log of logs) {
        const { tokenId, buyer, seller, price } = (log as unknown as { args: BoughtArgs }).args;
        console.log("—— 成交 Bought ——");
        console.log(`  tokenId : ${tokenId}`);
        console.log(`  buyer   : ${buyer}`);
        console.log(`  seller  : ${seller}`);
        console.log(`  price   : ${price !== undefined ? formatEther(price) : "?"} TOKEN`);
        console.log(`  tx      : ${log.transactionHash}`);
        console.log(`  block   : ${log.blockNumber}`);
        console.log("");
      }
    },
  });

  process.on("SIGINT", () => {
    console.log("\n停止监听...");
    unwatchListed();
    unwatchBought();
    process.exit(0);
  });
};

main().catch((error) => {
  console.error("发生错误:", error);
  process.exit(1);
});
