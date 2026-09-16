import type { RpcFailure, RpcResponse } from './types'

/**
 * Whether a desktop has told this phone it will not serve a Relay pairing RPC at all.
 *
 * `forbidden` is the code an old desktop actually sends. The mobile allowlist gate runs *before*
 * the RPC dispatcher (`runtime-rpc-websocket-dispatch.ts`), so a method a desktop predates is
 * absent from both lists and the gate answers first. Keying the "too old for Relay, stay on LAN"
 * fallback on `method_not_found` alone therefore never fired against the exact desktop the
 * fallback exists for — first-time pairing threw instead of committing a LAN host.
 *
 * `method_not_found` is kept because it is this fallback's pre-existing contract, not because a
 * shipped desktop sends it: both probes have been allowlisted and registered by the same commit
 * since Relay landed, and a desktop whose pairing provider is unwired answers `runtime_error`,
 * not absence. The arm is what keeps the fallback right if the gate ever stops answering first.
 *
 * See docs/reference/remote-wire-compatibility.md — a scope refusal is not a missing method.
 */
// Why the intersection rather than `RpcFailure`: a plain failure guard would narrow the *false*
// branch to `RpcSuccess`, and a refusal carrying any other code still reaches it.
export function isPairingRelayRpcUnavailable(
  response: RpcResponse
): response is RpcFailure & { error: { code: 'method_not_found' | 'forbidden' } } {
  return (
    !response.ok &&
    (response.error.code === 'method_not_found' || response.error.code === 'forbidden')
  )
}
