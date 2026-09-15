/**
 * 用一条 EIP-7702 交易，把 MyTokenV1.approve 与 TokenBankV2.deposit 原子执行。
 *
 * 为什么需要 7702：TokenBank.deposit 走 transferFrom(msg.sender, ...)，
 * approve 和 deposit 的 msg.sender 都必须是存款人 EOA。普通两笔交易做不到原子性；
 * 7702 让 EOA 临时（实际会一直保留到被清掉）执行智能合约代码，一次 execute 里连续两笔 inner call。
 *
 * 流程：
 *   1. 签 authorization，把 EOA 委托到 MetaMask EIP7702StatelessDeleGator
 *   2. 发 type 0x04 交易，to = EOA 自己，calldata = execute(batchMode, [approve, deposit])
 *   3. 执行时 address(this) = EOA，所以 token.approve / bank.deposit 看到的 msg.sender 都是 EOA
 *
 * 用法:
 *   npm run deposit7702 -- <amount>
 */
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import { createTransport, httpRpcUrl, resolveChain } from "../lib/chain.js";

dotenv.config();

/** MetaMask EIP7702StatelessDeleGator（主网 / Sepolia 同址 CREATE2） */
const DEFAULT_DELEGATE = getAddress(
  "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
);

/**
 * ERC-7579 ModeCode：第 1 字节 CALLTYPE_BATCH=0x01，第 2 字节 EXECTYPE_DEFAULT=0x00。
 * 与 viem ERC-7821 `executionMode.default` 相同。
 */
const BATCH_MODE =
  "0x0100000000000000000000000000000000000000000000000000000000000000" as Hex;

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

const tokenBankAbi = parseAbi([
  "function deposit(uint256 amount)",
  "function balances(address) view returns (uint256)",
  "function token() view returns (address)",
]);

const delegatorAbi = parseAbi([
  // onlyEntryPointOrSelf：外人不能对已委托的 EOA 直接调 execute
  "function execute(bytes32 mode, bytes executionCalldata) payable",
  "function supportsExecutionMode(bytes32 mode) view returns (bool)",
]);

function printUsage(): void {
  console.log(`EIP-7702 原子存款：approve(TokenBank) + deposit(amount)

用法:
  npm run deposit7702 -- <amount>

参数:
  amount   存款数量（人可读 TOKEN）

.env:
  PRIVATE_KEY              存款人私钥（EOA 自己发交易）
  RPC_URL                  Sepolia RPC
  CHAIN_ID                 11155111
  MY_TOKEN_V1_ADDRESS      MyTokenV1 地址
  TOKEN_BANK_V2_ADDRESS    TokenBankV2 地址
  SIMPLE_DELEGATE_ADDRESS  可选；默认 MetaMask EIP7702StatelessDeleGator
  TOKEN_DECIMALS           可选；默认 18
`);
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
  const raw = process.env.TOKEN_DECIMALS ?? "18";
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

/** 编码 Delegator.execute 的第二参数：abi.encode(Execution[])，即 ERC-7579 batch calldata。 */
function encodeBatchExecutions(
  token: Address,
  bank: Address,
  amount: bigint,
): Hex {
  const approveCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [bank, amount],
  });
  const depositCalldata = encodeFunctionData({
    abi: tokenBankAbi,
    functionName: "deposit",
    args: [amount],
  });

  // 字段名 callData 对应合约 Execution；按 (address,uint256,bytes) 位置编码，与 viem 的 data 等价。
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    [
      [
        { target: token, value: 0n, callData: approveCalldata },
        { target: bank, value: 0n, callData: depositCalldata },
      ],
    ],
  );
}

async function main(): Promise<void> {
  const [, , amountRaw, extra] = process.argv;
  if (!amountRaw || amountRaw === "-h" || amountRaw === "--help") {
    printUsage();
    return;
  }
  if (extra !== undefined) {
    throw new Error("多余参数。用法: npm run deposit7702 -- <amount>");
  }

  const decimals = loadTokenDecimals();
  const amount = parseAmount(requireArg("amount", amountRaw), decimals);
  if (amount <= 0n) {
    throw new Error("amount 必须大于 0");
  }

  const chainId = loadChainId();
  const chain = resolveChain(chainId);
  const rpcUrl = httpRpcUrl(requireEnv("RPC_URL"));
  const privateKey = loadPrivateKey();
  const account = privateKeyToAccount(privateKey);
  const token = getAddress(requireEnv("MY_TOKEN_V1_ADDRESS"));
  const bank = getAddress(requireEnv("TOKEN_BANK_V2_ADDRESS"));
  const delegate = process.env.SIMPLE_DELEGATE_ADDRESS
    ? getAddress(process.env.SIMPLE_DELEGATE_ADDRESS)
    : DEFAULT_DELEGATE;

  const publicClient = createPublicClient({
    chain,
    transport: createTransport(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: createTransport(rpcUrl),
  });

  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== chainId) {
    throw new Error(
      `CHAIN_ID=${chainId} 与 RPC 实际 chainId=${rpcChainId} 不一致`,
    );
  }

  // 读实现合约本身（尚未委托时 EOA 还没有这段代码）
  let supportsBatch: boolean;
  try {
    supportsBatch = await publicClient.readContract({
      address: delegate,
      abi: delegatorAbi,
      functionName: "supportsExecutionMode",
      args: [BATCH_MODE],
    });
  } catch {
    throw new Error(
      `委托合约 ${delegate} 无法读取 supportsExecutionMode（地址错误或当前链未部署）`,
    );
  }

  const [
    ethBalance,
    tokenBalance,
    bankToken,
    bankBalanceBefore,
    currentDelegate,
  ] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: bank,
      abi: tokenBankAbi,
      functionName: "token",
    }),
    publicClient.readContract({
      address: bank,
      abi: tokenBankAbi,
      functionName: "balances",
      args: [account.address],
    }),
    // 7702 委托设计符：code = 0xef0100 || delegate；无委托则 undefined
    publicClient.getDelegation({ address: account.address }),
  ]);

  const bankTokenAddress = getAddress(bankToken);
  if (bankTokenAddress !== token) {
    throw new Error(
      `TokenBank.token()=${bankTokenAddress} 与 MY_TOKEN_V1_ADDRESS=${token} 不一致`,
    );
  }
  if (!supportsBatch) {
    throw new Error(`委托合约不支持批量 execute mode ${BATCH_MODE}`);
  }
  if (ethBalance === 0n) {
    throw new Error("ETH 余额为 0，无法支付 gas");
  }
  if (tokenBalance < amount) {
    throw new Error(
      `TOKEN 余额不足: 拥有 ${formatUnits(tokenBalance, decimals)}，需要 ${formatUnits(amount, decimals)}`,
    );
  }

  // 已委托到同一实现则不必再带 authorizationList，否则会无谓消耗 authority nonce
  const alreadyDelegated = currentDelegate === delegate;
  const executionCalldata = encodeBatchExecutions(token, bank, amount);

  console.log("模式: EIP-7702 原子存款（approve + deposit）");
  console.log(`网络: ${chain.name} (chainId=${chain.id})`);
  console.log(`RPC:  ${rpcUrl}`);
  console.log(`From: ${account.address}`);
  console.log(`Token: ${token}`);
  console.log(`Bank:  ${bank}`);
  console.log(`Delegate: ${delegate}`);
  console.log(`Amount: ${formatUnits(amount, decimals)} (raw=${amount.toString()})`);
  console.log(`ETH 余额: ${formatEther(ethBalance)}`);
  console.log(
    `TOKEN 余额: ${formatUnits(tokenBalance, decimals)} / 银行存款: ${formatUnits(bankBalanceBefore, decimals)}`,
  );
  console.log(
    `EOA 当前委托: ${currentDelegate ?? "无"}` +
      (alreadyDelegated ? "（已是目标实现，本笔不再带 authorizationList）" : ""),
  );

  // EOA 自己发 tx 时必须 executor:"self"：authorization.nonce = tx.nonce + 1
  // （7702 先消耗 tx nonce，再处理 authorization list）
  const authorization = alreadyDelegated
    ? undefined
    : await walletClient.signAuthorization({
        account,
        contractAddress: delegate,
        executor: "self",
      });
  if (authorization) {
    console.log(
      `已本地签名 EIP-7702 authorization（未发交易，无 tx hash）: chainId=${authorization.chainId} nonce=${authorization.nonce} address=${authorization.address}`,
    );
  } else {
    console.log("跳过 signAuthorization：EOA 已委托到目标实现，无新 authorization，也无额外交易");
  }

  // to 必须是 EOA：委托生效后，EOA 上跑的是 Delegator.execute
  const hash = await walletClient.writeContract({
    abi: delegatorAbi,
    address: account.address, // EOA address
    functionName: "execute",
    args: [BATCH_MODE, executionCalldata],
    ...(authorization ? { authorizationList: [authorization] } : {}),
  });
  console.log(`Tx hash: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`状态: ${receipt.status === "success" ? "成功" : "失败"}`);
  console.log(`区块: ${receipt.blockNumber}`);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);
  if (receipt.status !== "success") {
    throw new Error(`交易失败（reverted）: ${hash}`);
  }

  const [tokenBalanceAfter, bankBalanceAfter, delegateAfter] =
    await Promise.all([
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      }),
      publicClient.readContract({
        address: bank,
        abi: tokenBankAbi,
        functionName: "balances",
        args: [account.address],
      }),
      publicClient.getDelegation({ address: account.address }),
    ]);

  if (bankBalanceAfter !== bankBalanceBefore + amount) {
    throw new Error(
      `银行存款未增加 ${formatUnits(amount, decimals)}: ${formatUnits(bankBalanceBefore, decimals)} → ${formatUnits(bankBalanceAfter, decimals)}`,
    );
  }
  if (tokenBalanceAfter !== tokenBalance - amount) {
    throw new Error(
      `TOKEN 余额未减少 ${formatUnits(amount, decimals)}: ${formatUnits(tokenBalance, decimals)} → ${formatUnits(tokenBalanceAfter, decimals)}`,
    );
  }

  console.log(
    `TOKEN 余额: ${formatUnits(tokenBalance, decimals)} → ${formatUnits(tokenBalanceAfter, decimals)}`,
  );
  console.log(
    `银行存款: ${formatUnits(bankBalanceBefore, decimals)} → ${formatUnits(bankBalanceAfter, decimals)}`,
  );
  console.log(`EOA 委托后: ${delegateAfter ?? "无"}`);
  console.log(
    "提示: EIP-7702 委托会保留在 EOA 上，直到再签一条指向 address(0) 的 authorization 清掉。execute 仅允许 EOA 自己或 EntryPoint 调用。",
  );
}

main().catch((err) => {
  console.error("错误:", err instanceof Error ? err.message : err);
  process.exit(1);
});
