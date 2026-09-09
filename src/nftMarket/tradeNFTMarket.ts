import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  getAddress,
  http,
  parseEther,
  parseAbiItem,
  parseEventLogs,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import NFTMarketAbiJson from "../abis/NFTMarket.json" with { type: "json" };
import MyERC721NFTAbiJson from "../abis/MyERC721NFT.json" with { type: "json" };
import MyTokenAbiJson from "../abis/MyTokenERC1363.json" with { type: "json" };

dotenv.config();

/** Anvil #0 — 默认卖家（通常也是部署人，持有初始 TOKEN） */
const DEFAULT_SELLER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
/** Anvil #1 — 默认买家 */
const DEFAULT_BUYER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

const NFT_URI = "ipfs://QmTg75dRHikf7joDYxiMMznQh9MSpF27MVfzeZi6eT94TR";

const NFTMarketAbi = NFTMarketAbiJson as Abi;
const MyERC721NFTAbi = MyERC721NFTAbiJson as Abi;
const MyTokenAbi = MyTokenAbiJson as Abi;

/** 写交易用 HTTP；若 .env 是 ws:// 则自动换成 http:// */
function toHttpRpc(rpcUrl: string): string {
  if (rpcUrl.startsWith("ws://")) return `http://${rpcUrl.slice("ws://".length)}`;
  if (rpcUrl.startsWith("wss://")) return `https://${rpcUrl.slice("wss://".length)}`;
  return rpcUrl;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`请在 .env 中设置 ${name}`);
  return value;
}

/**
 * 演示环境准备：给买家打入支付 TOKEN。
 *
 * 部署后全部 MyTokenERC1363 在部署人（本脚本默认卖家 Anvil #0）手里，
 * 买家（Anvil #1）余额为 0。真实市场上架/购买不需要这一步——买家应自备 TOKEN。
 * 本函数仅用于本地 demo，建议在部署合约、读出地址之后、挂单买卖之前调用一次。
 */
async function fundBuyerForDemo(params: {
  publicClient: ReturnType<typeof createPublicClient>;
  sellerWallet: ReturnType<typeof createWalletClient>;
  paymentToken: Address;
  buyer: Address;
  amount: bigint;
}): Promise<Hex> {
  const { publicClient, sellerWallet, paymentToken, buyer, amount } = params;

  console.log("0. [demo] 给买家转入支付 TOKEN（非市场上架/购买流程）...");
  const hash = await sellerWallet.writeContract({
    address: paymentToken,
    abi: MyTokenAbi,
    functionName: "transfer",
    args: [buyer, amount],
    chain: foundry,
    account: sellerWallet.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`   funded ${formatEther(amount)} TOKEN → ${buyer}  tx=${hash}\n`);
  return hash;
}

async function main() {
  const rpcUrl = toHttpRpc(requireEnv("RPC_URL"));
  const marketAddress = getAddress(requireEnv("NFT_MARKET_ADDRESS"));
  const price = parseEther(process.env.LIST_PRICE ?? "10");
  const sellerKey = (process.env.SELLER_PRIVATE_KEY ?? DEFAULT_SELLER_KEY) as Hex;
  const buyerKey = (process.env.BUYER_PRIVATE_KEY ?? DEFAULT_BUYER_KEY) as Hex;

  const seller = privateKeyToAccount(sellerKey);
  const buyer = privateKeyToAccount(buyerKey);

  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(rpcUrl),
  });

  const sellerWallet = createWalletClient({
    account: seller,
    chain: foundry,
    transport: http(rpcUrl),
  });

  const buyerWallet = createWalletClient({
    account: buyer,
    chain: foundry,
    transport: http(rpcUrl),
  });

  // 部署后从 Market 读出绑定的支付代币 / NFT 合约
  const paymentToken = getAddress(
    (await publicClient.readContract({
      address: marketAddress,
      abi: NFTMarketAbi,
      functionName: "paymentToken",
    })) as Address,
  );

  const nft = getAddress(
    (await publicClient.readContract({
      address: marketAddress,
      abi: NFTMarketAbi,
      functionName: "nft",
    })) as Address,
  );

  console.log("=== NFTMarket 挂单 & 买卖 ===");
  console.log(`RPC        : ${rpcUrl}`);
  console.log(`Market     : ${marketAddress}`);
  console.log(`NFT        : ${nft}`);
  console.log(`Token      : ${paymentToken}`);
  console.log(`Seller     : ${seller.address}`);
  console.log(`Buyer      : ${buyer.address}`);
  console.log(`List price : ${formatEther(price)} TOKEN\n`);

  // 部署完成后的 demo 准备：先给买家打款，再走挂单 / 购买（买家得有 Token 才能购买 NFT）
  await fundBuyerForDemo({
    publicClient,
    sellerWallet,
    paymentToken,
    buyer: buyer.address,
    amount: price,
  });

  // 1) 卖家铸造一枚新 NFT（从 Transfer log 解析 tokenId）
  console.log("1. 卖家 mint NFT...");
  const mintHash = await sellerWallet.writeContract({
    address: nft,
    abi: MyERC721NFTAbi,
    functionName: "mint",
    args: [seller.address, NFT_URI],
  });
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
  const transferLogs = parseEventLogs({
    abi: [
      parseAbiItem(
        "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
      ),
    ],
    eventName: "Transfer",
    logs: mintReceipt.logs,
  });
  const mintTransfer = transferLogs.find((log) => log.args.from === zeroAddress);
  if (mintTransfer?.args.tokenId === undefined) {
    throw new Error("mint 收据中未找到 Transfer(from=0x0) 事件");
  }
  const tokenId = mintTransfer.args.tokenId;
  console.log(`   tokenId=${tokenId}  tx=${mintHash}`);

  // 2) 卖家 safeTransferFrom(..., abi.encode(price)) 上架，无需 approve（触发 Market.onERC721Received）
  console.log("2. 卖家 safeTransferFrom 上架（带 price data）...");
  const listData = encodeAbiParameters([{ type: "uint256" }], [price]);
  const listHash = await sellerWallet.writeContract({
    address: nft,
    abi: MyERC721NFTAbi,
    functionName: "safeTransferFrom",
    args: [seller.address, marketAddress, tokenId, listData],
  });
  await publicClient.waitForTransactionReceipt({ hash: listHash });
  console.log(`   Listed  tx=${listHash}`);

  // 3) 买家用 ERC-1363 transferAndCall 一笔完成支付+购买（触发 Market.onTransferReceived）
  console.log("3. 买家 transferAndCall 购买（ERC-1363）...");
  const buyData = encodeAbiParameters([{ type: "uint256" }], [tokenId]);
  const buyHash = await buyerWallet.writeContract({
    address: paymentToken,
    abi: MyTokenAbi,
    functionName: "transferAndCall",
    args: [marketAddress, price, buyData],
  });
  await publicClient.waitForTransactionReceipt({ hash: buyHash });
  console.log(`   Bought  tx=${buyHash}`);

  const owner = (await publicClient.readContract({
    address: nft,
    abi: MyERC721NFTAbi,
    functionName: "ownerOf",
    args: [tokenId],
  })) as Address;

  console.log("\n=== 完成 ===");
  console.log(`NFT #${tokenId} 当前持有人: ${owner}`);
  console.log(`期望买家: ${buyer.address}`);
}

main().catch((error) => {
  console.error("发生错误:", error);
  process.exit(1);
});
