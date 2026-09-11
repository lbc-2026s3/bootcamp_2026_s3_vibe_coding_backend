/**
 * 命令行钱包：从 .env 加载私钥 / RPC / ERC20 地址，按参数构建并发送 EIP-1559 交易。
 *
 * 用法:
 *   npm run wallet -- eth <to> <amount>
 *   npm run wallet -- erc20 <to> <amount>
 *
 * amount 为人可读单位（ETH 或 TOKEN），默认 18 位小数（TOKEN_DECIMALS 可覆盖）。
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatGwei,
  formatUnits,
  getAddress,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { prepareTransactionRequest } from "viem/actions";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import MyTokenAbiJson from "../abis/MyTokenERC1363.json" with { type: "json" };
import { createTransport, httpRpcUrl, resolveChain } from "../lib/chain.js";

dotenv.config();

const MyTokenAbi = MyTokenAbiJson as Abi;

/** Anvil account#0 — 仅本地缺省私钥时回退 */
const ANVIL_ACCOUNT0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

function printUsage(): void {
  console.log(`命令行钱包（EIP-1559）

用法:
  npm run wallet -- eth <to> <amount>
  npm run wallet -- erc20 <to> <amount>

参数:
  to       收款地址
  amount   转账数量（ETH 或 TOKEN 人可读单位）

.env:
  PRIVATE_KEY      发送方私钥（可缺省，本地回退 Anvil #0）
  TOKEN_ADDRESS    MyTokenERC1363 合约地址（erc20 必需）
  RPC_URL          默认 http://127.0.0.1:8545
  CHAIN_ID         默认 31337（Anvil）
  TOKEN_DECIMALS   默认 18
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

async function sendEip1559Tx(params: {
  privateKey: Hex;
  to: Address;
  value: bigint;
  data?: Hex;
  label: string;
}): Promise<TransactionReceipt> {
  const { privateKey, to, value, data, label } = params;

  const rpcUrl = httpRpcUrl(process.env.RPC_URL ?? "http://127.0.0.1:8545");
  const chainId = Number(process.env.CHAIN_ID ?? "31337");
  const chain = resolveChain(chainId);
  const account = privateKeyToAccount(privateKey);

  const publicClient = createPublicClient({
    chain,
    transport: createTransport(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: createTransport(rpcUrl),
  });

  const [balance, nonce, fees] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.getTransactionCount({ address: account.address }),
    publicClient.estimateFeesPerGas(),
  ]);

  console.log(`模式: ${label}`);
  console.log(`网络: ${chain.name} (chainId=${chain.id})`);
  console.log(`RPC:  ${rpcUrl}`);
  console.log(`From: ${account.address}`);
  console.log(`To:   ${to}`);
  console.log(`ETH 余额: ${formatEther(balance)}`);
  console.log(`Nonce: ${nonce}`);
  console.log(
    `Fees: maxFee=${formatGwei(fees.maxFeePerGas ?? 0n)} gwei, tip=${formatGwei(fees.maxPriorityFeePerGas ?? 0n)} gwei`,
  );

  const txParams = {
    account,
    to,
    value,
    data,
    chainId: chain.id,
    chain,
    type: "eip1559" as const,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    nonce,
  };

  const preparedTx = await prepareTransactionRequest(publicClient, txParams);
  console.log("Prepared EIP-1559 tx:", {
    to: preparedTx.to,
    value: preparedTx.value?.toString(),
    gas: preparedTx.gas?.toString(),
    maxFeePerGas: preparedTx.maxFeePerGas
      ? `${formatGwei(preparedTx.maxFeePerGas)} gwei`
      : undefined,
    maxPriorityFeePerGas: preparedTx.maxPriorityFeePerGas
      ? `${formatGwei(preparedTx.maxPriorityFeePerGas)} gwei`
      : undefined,
    nonce: preparedTx.nonce,
    type: preparedTx.type,
  });

  const signedTx = await walletClient.signTransaction(preparedTx);
  const hash = await publicClient.sendRawTransaction({
    serializedTransaction: signedTx,
  });
  console.log(`Tx hash: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`状态: ${receipt.status === "success" ? "成功" : "失败"}`);
  console.log(`区块: ${receipt.blockNumber}`);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);
  if (receipt.status !== "success") {
    throw new Error(`交易失败（reverted）: ${hash}`);
  }
  return receipt;
}

async function transferEth(toRaw: string, amountRaw: string): Promise<void> {
  const to = getAddress(toRaw);
  const chainId = Number(process.env.CHAIN_ID ?? "31337");
  const value = parseAmount(amountRaw, 18);
  console.log(`转账 ETH: ${amountRaw} → ${to}`);

  await sendEip1559Tx({
    privateKey: loadPrivateKey(chainId),
    to,
    value,
    label: "ETH transfer",
  });
}

async function transferErc20(toRaw: string, amountRaw: string): Promise<void> {
  const tokenAddress = process.env.TOKEN_ADDRESS;
  if (!tokenAddress) {
    throw new Error("请在 .env 中设置 TOKEN_ADDRESS（MyTokenERC1363 部署地址）");
  }

  const to = getAddress(toRaw);
  const token = getAddress(tokenAddress);
  const decimalsRaw = process.env.TOKEN_DECIMALS ?? "18";
  const decimals = Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`TOKEN_DECIMALS 无效: ${decimalsRaw}`);
  }
  const amount = parseAmount(amountRaw, decimals);
  const chainId = Number(process.env.CHAIN_ID ?? "31337");
  const chain = resolveChain(chainId);
  const privateKey = loadPrivateKey(chainId);
  const account = privateKeyToAccount(privateKey);
  const rpcUrl = httpRpcUrl(process.env.RPC_URL ?? "http://127.0.0.1:8545");

  const publicClient = createPublicClient({
    chain,
    transport: createTransport(rpcUrl),
  });

  const tokenBalance = (await publicClient.readContract({
    address: token,
    abi: MyTokenAbi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  console.log(`转账 ERC20: ${amountRaw} (decimals=${decimals}) → ${to}`);
  console.log(`Token: ${token}`);
  console.log(
    `TOKEN 余额: ${formatUnits(tokenBalance, decimals)} / 转出: ${formatUnits(amount, decimals)}`,
  );
  if (tokenBalance < amount) {
    throw new Error(
      `TOKEN 余额不足: 拥有 ${formatUnits(tokenBalance, decimals)}，需要 ${formatUnits(amount, decimals)}`,
    );
  }

  const data = encodeFunctionData({
    abi: MyTokenAbi,
    functionName: "transfer",
    args: [to, amount],
  });

  await sendEip1559Tx({
    privateKey,
    to: token,
    value: 0n,
    data,
    label: "ERC20 transfer (MyTokenERC1363)",
  });
}

async function main(): Promise<void> {
  const [, , command, to, amount] = process.argv;

  if (!command || command === "-h" || command === "--help") {
    printUsage();
    return;
  }

  switch (command) {
    case "eth":
      await transferEth(requireArg("to", to), requireArg("amount", amount));
      break;
    case "erc20":
      await transferErc20(requireArg("to", to), requireArg("amount", amount));
      break;
    default:
      printUsage();
      throw new Error(`未知命令: ${command}（仅支持 eth | erc20）`);
  }
}

main().catch((err) => {
  console.error("错误:", err instanceof Error ? err.message : err);
  process.exit(1);
});
