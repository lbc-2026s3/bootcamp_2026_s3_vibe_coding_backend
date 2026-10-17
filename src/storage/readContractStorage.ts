/**
 * 用 viem 读取 Test 合约的原始存储槽。
 *
 * 布局见 foundry src/Test.sol：
 *   槽位 0  Optimized.a (uint128, 低 16 字节) 与 Optimized.c (uint128, 高 16 字节)
 *   槽位 1  Optimized.b (address, 低 20 字节)
 *   槽位 2  mapping balances 的基槽
 *           balances[key] = keccak256(abi.encode(key, 2))
 *
 * 用法:
 *   npm run readStorage
 *   npm run readStorage -- 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
 *
 * .env:
 *   RPC_URL       必填
 *   TEST_ADDRESS  必填，forge script script/Test.s.sol 部署得到的地址
 *   CHAIN_ID      默认 31337
 */
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  keccak256,
  slice,
  toHex,
  type Address,
  type Hex,
} from "viem";
import dotenv from "dotenv";
import { createTransport, httpRpcUrl, resolveChain } from "../lib/chain.js";

dotenv.config();

/** 与 Test.DEMO_ACCOUNT 一致（Anvil account #1）。 */
const DEFAULT_BALANCE_KEY: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** struct Optimized 占槽 0、1，mapping 基槽紧随其后。 */
const BALANCES_MAPPING_SLOT = 2n;
const UINT128_MASK = (1n << 128n) - 1n;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`请在 .env 中设置 ${name}`);
  return value;
}

function requireStorage(slot: Hex | undefined, label: string): Hex {
  if (!slot) throw new Error(`${label} 读取结果为空`);
  return slot;
}

/** 槽位 0：Solidity 从低位开始打包，a 在低 16 字节，c 在高 16 字节。 */
function decodeOptimizedHead(slot: Hex): { a: bigint; c: bigint } {
  const word = hexToBigInt(slot);
  return {
    a: word & UINT128_MASK,
    c: word >> 128n,
  };
}

/** 槽位 1：address 占低 20 字节。 */
function decodeAddressSlot(slot: Hex): Address {
  return getAddress(slice(slot, 12));
}

/**
 * mapping 值的槽位。
 * 必须用 abi.encode（两边都补齐到 32 字节），不能用 abi.encodePacked：
 * encodePacked 会把 address 收成 20 字节，算出来的槽是错的。
 */
function mappingValueSlot(key: Address, mappingSlot: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
      ],
      [key, mappingSlot],
    ),
  );
}

async function main(): Promise<void> {
  const keyArg = process.argv[2];
  const balanceKey = getAddress(keyArg ?? process.env.BALANCE_KEY ?? DEFAULT_BALANCE_KEY);

  const rpcUrl = httpRpcUrl(requireEnv("RPC_URL"));
  const contractAddress = getAddress(requireEnv("TEST_ADDRESS"));
  const chainId = Number(process.env.CHAIN_ID ?? "31337");
  const chain = resolveChain(chainId);

  const client = createPublicClient({
    chain,
    transport: createTransport(rpcUrl),
  });

  const rpcChainId = await client.getChainId();
  if (rpcChainId !== chainId) {
    throw new Error(`CHAIN_ID=${chainId} 与 RPC 实际 chainId=${rpcChainId} 不一致`);
  }

  const slot0 = requireStorage(
    await client.getStorageAt({ address: contractAddress, slot: toHex(0) }),
    "Slot 0",
  );
  const slot1 = requireStorage(
    await client.getStorageAt({ address: contractAddress, slot: toHex(1) }),
    "Slot 1",
  );
  const slot2 = requireStorage(
    await client.getStorageAt({ address: contractAddress, slot: toHex(BALANCES_MAPPING_SLOT) }),
    "Slot 2",
  );

  const balanceSlot = mappingValueSlot(balanceKey, BALANCES_MAPPING_SLOT);
  const balanceWord = requireStorage(
    await client.getStorageAt({ address: contractAddress, slot: balanceSlot }),
    "balances",
  );

  const { a, c } = decodeOptimizedHead(slot0);
  const b = decodeAddressSlot(slot1);

  console.log(`网络: ${chain.name} (chainId=${chain.id})`);
  console.log(`RPC:  ${rpcUrl}`);
  console.log(`合约: ${contractAddress}`);
  console.log("---");
  console.log("Slot 0:", slot0);
  console.log(`  a (uint128): ${a.toString()}`);
  console.log(`  c (uint128): ${c.toString()}`);
  console.log("Slot 1:", slot1);
  console.log(`  b (address): ${b}`);
  console.log("Slot 2:", slot2);
  console.log(`  balances 基槽 (uint256): ${hexToBigInt(slot2).toString()}`);
  console.log(`balances[${balanceKey}]`);
  console.log(`  mapping 基槽: ${BALANCES_MAPPING_SLOT.toString()}`);
  console.log(`  值槽 keccak256(abi.encode(key, ${BALANCES_MAPPING_SLOT.toString()})): ${balanceSlot}`);
  console.log(`  value: ${hexToBigInt(balanceWord).toString()}`);
}

main().catch((err) => {
  console.error("错误:", err instanceof Error ? err.message : err);
  process.exit(1);
});
