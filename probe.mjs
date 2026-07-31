import { createThruClient } from "@thru/thru-sdk"
import { createGrpcTransport, createGrpcWebTransport } from "@connectrpc/connect-node"

const HOSTS = [
  "https://rpc.alphanet.thru.org",
  "https://grpc-web.alphanet.thru.org",
  "https://grpc.alphanet.thru.org",
]

const PROTOCOLS = [
  ["grpc", createGrpcTransport],
  ["grpc-web", createGrpcWebTransport],
]

const TIMEOUT_MS = 8000
const testAddress = process.argv[2] ?? null

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timed out")), ms)),
  ])
}

const working = []

for (const host of HOSTS) {
  for (const [name, make] of PROTOCOLS) {
    const label = name.padEnd(8) + " " + host
    try {
      const client = createThruClient({ transport: make({ baseUrl: host }) })
      const chainId = await withTimeout(client.chain.getChainId(), TIMEOUT_MS, "getChainId")
      console.log("OK    " + label + "   chainId=" + JSON.stringify(chainId))
      working.push({ host, protocol: name, client })
    } catch (err) {
      const msg = String(err?.message ?? err).split("\n")[0].slice(0, 110)
      console.log("FAIL  " + label + "   " + msg)
    }
  }
}

console.log("")

if (working.length === 0) {
  console.log("Nothing answered from Node.")
  process.exit(1)
}

const best = working[0]
console.log("Use this in the proxy:  protocol=" + best.protocol + "  url=" + best.host)

if (testAddress) {
  console.log("")
  console.log("Reading account " + testAddress + " ...")
  try {
    const account = await withTimeout(best.client.accounts.get(testAddress), TIMEOUT_MS, "accounts.get")
    const bytes = account.data?.data
    console.log("  owner    : " + (account.meta?.owner?.toThruFmt() ?? "(none)"))
    console.log("  dataSize : " + (account.meta?.dataSize ?? 0))
    if (bytes?.length) {
      console.log("  kindByte : " + bytes[0] + " (1=root registrar, 2=domain)")
      console.log("  base64   : " + Buffer.from(bytes).toString("base64").slice(0, 60) + "...")
    }
  } catch (err) {
    console.log("  read failed: " + (err?.message ?? err))
  }
}
