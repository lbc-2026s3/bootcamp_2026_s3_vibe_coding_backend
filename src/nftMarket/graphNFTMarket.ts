import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import NFTMarketAbiJson from "../abis/NFTMarket.json" with { type: "json" };
import MyERC721NFTAbiJson from "../abis/MyERC721NFT.json" with { type: "json" };
import MyTokenAbiJson from "../abis/MyTokenERC1363.json" with { type: "json" };

dotenv.config();

const PAYMENT_TOKEN = getAddress("0x3a4a3C1E5c6CF156285121861A2F89B79ef7812f");
const NFT = getAddress("0x755501034AB05a86283B83291571cdCE64D91f11");
const NFT_MARKET = getAddress("0x28Ec070763b4251D0cDa94C29A231e2306Ef4C6b");

const TOKEN_ID = 0n;
const PRICE = parseEther("10");
const BUY_DELAY_MS = 2 * 60 * 1000;

const NFTMarketAbi = NFTMarketAbiJson as Abi;
const MyERC721NFTAbi = MyERC721NFTAbiJson as Abi;
const MyTokenAbi = MyTokenAbiJson as Abi;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`请在 .env 中设置 ${name}`);
  return value;
}

function requirePrivateKey(name: string): Hex {
  const value = requireEnv(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} 必须是 0x 开头的 32 字节私钥`);
  }
  return value as Hex;
}

function toHttpRpc(rpcUrl: string): string {
  if (rpcUrl.startsWith("ws://")) return `http://${rpcUrl.slice("ws://".length)}`;
  if (rpcUrl.startsWith("wss://")) return `https://${rpcUrl.slice("wss://".length)}`;
  return rpcUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listingPrice(listing: { price: bigint } | readonly [Address, bigint]): bigint {
  if ("price" in listing && typeof listing.price === "bigint") return listing.price;
  return (listing as readonly [Address, bigint])[1];
}

async function main() {
  const rpcUrl = toHttpRpc(requireEnv("RPC_URL"));
  const seller = privateKeyToAccount(requirePrivateKey("ACCOUNT1"));
  const buyer = privateKeyToAccount(requirePrivateKey("ACCOUNT2"));

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const sellerWallet = createWalletClient({
    account: seller,
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const buyerWallet = createWalletClient({
    account: buyer,
    chain: sepolia,
    transport: http(rpcUrl),
  });

  console.log("=== Sepolia NFTMarket 上架 & 购买 ===");
  console.log(`RPC     : ${rpcUrl}`);
  console.log(`Market  : ${NFT_MARKET}`);
  console.log(`NFT     : ${NFT}`);
  console.log(`Token   : ${PAYMENT_TOKEN}`);
  console.log(`ACCOUNT1: ${seller.address}`);
  console.log(`ACCOUNT2: ${buyer.address}`);
  console.log(`tokenId : ${TOKEN_ID}`);
  console.log(`price   : ${formatEther(PRICE)} TOKEN\n`);

  const owner = getAddress(
    (await publicClient.readContract({
      address: NFT,
      abi: MyERC721NFTAbi,
      functionName: "ownerOf",
      args: [TOKEN_ID],
    })) as Address,
  );
  if (owner !== seller.address) {
    throw new Error(`NFT #${TOKEN_ID} 当前持有人是 ${owner}，不是 ACCOUNT1 ${seller.address}`);
  }

  const listing = (await publicClient.readContract({
    address: NFT_MARKET,
    abi: NFTMarketAbi,
    functionName: "listings",
    args: [TOKEN_ID],
  })) as { price: bigint } | readonly [Address, bigint];
  const openPrice = listingPrice(listing);
  if (openPrice !== 0n) {
    throw new Error(`NFT #${TOKEN_ID} 已在市场上架，价格 ${formatEther(openPrice)} TOKEN`);
  }

  console.log("1. ACCOUNT1 给 ACCOUNT2 转入支付 TOKEN...");
  const fundHash = await sellerWallet.writeContract({
    address: PAYMENT_TOKEN,
    abi: MyTokenAbi,
    functionName: "transfer",
    args: [buyer.address, PRICE],
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log(`   tx=${fundHash}`);

  console.log("2. ACCOUNT1 safeTransferFrom 上架 NFT #0...");
  const listData = encodeAbiParameters([{ type: "uint256" }], [PRICE]);
  const listHash = await sellerWallet.writeContract({
    address: NFT,
    abi: MyERC721NFTAbi,
    functionName: "safeTransferFrom",
    args: [seller.address, NFT_MARKET, TOKEN_ID, listData],
  });
  const listReceipt = await publicClient.waitForTransactionReceipt({ hash: listHash });
  console.log(`   tx=${listHash}  block=${listReceipt.blockNumber}`);

  const buyAt = new Date(Date.now() + BUY_DELAY_MS);
  console.log(`   上架已确认，等待 2 分钟后由 ACCOUNT2 购买（约 ${buyAt.toISOString()}）...`);
  await sleep(BUY_DELAY_MS);

  console.log("3. ACCOUNT2 transferAndCall 购买...");
  const buyData = encodeAbiParameters([{ type: "uint256" }], [TOKEN_ID]);
  const buyHash = await buyerWallet.writeContract({
    address: PAYMENT_TOKEN,
    abi: MyTokenAbi,
    functionName: "transferAndCall",
    args: [NFT_MARKET, PRICE, buyData],
  });
  await publicClient.waitForTransactionReceipt({ hash: buyHash });
  console.log(`   tx=${buyHash}`);

  const newOwner = getAddress(
    (await publicClient.readContract({
      address: NFT,
      abi: MyERC721NFTAbi,
      functionName: "ownerOf",
      args: [TOKEN_ID],
    })) as Address,
  );

  console.log("\n=== 完成 ===");
  console.log(`NFT #${TOKEN_ID} 当前持有人: ${newOwner}`);
  console.log(`期望买家: ${buyer.address}`);
  if (newOwner !== buyer.address) {
    throw new Error("购买后 NFT 持有人不是 ACCOUNT2");
  }
}

main().catch((error) => {
  console.error("发生错误:", error);
  process.exit(1);
});
