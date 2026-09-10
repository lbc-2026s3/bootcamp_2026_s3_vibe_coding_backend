import { http, webSocket, type Chain, type Transport } from "viem";
import { anvil, sepolia } from "viem/chains";

export function createTransport(rpcUrl: string): Transport {
  if (rpcUrl.startsWith("ws://") || rpcUrl.startsWith("wss://")) {
    return webSocket(rpcUrl);
  }
  return http(rpcUrl);
}

export function resolveChain(chainId: number): Chain {
  if (chainId === anvil.id) return anvil;
  if (chainId === sepolia.id) return sepolia;
  throw new Error(`不支持的 CHAIN_ID: ${chainId}（仅支持 Anvil 31337 与 Sepolia 11155111）`);
}

export function httpRpcUrl(rpcUrl: string): string {
  if (rpcUrl.startsWith("ws://")) return rpcUrl.replace("ws://", "http://");
  if (rpcUrl.startsWith("wss://")) return rpcUrl.replace("wss://", "https://");
  return rpcUrl;
}
