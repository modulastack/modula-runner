function syntheticProofKey(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64url')
}

function fixtureMarker(name: string): string {
  return `[runtime-red-fixture:${name}]`
}

export const runtimeRedBindingId = ['123e4567', 'e89b', '42d3', 'a456', '426614174000'].join('-')
export const pairingFixtureBearer = syntheticProofKey(0)
export const pairingFixtureNonce = syntheticProofKey(1)
export const runtimeRedFixtureApiKey = fixtureMarker('api-key')
export const runtimeRedFixtureCredential = fixtureMarker('control-plane-token')
export const runtimeRedRejectedCredential = fixtureMarker('rejected-control-plane-token')
export const runtimeRedFixtureEndpoint = 'http://127.0.0.1:11434'
export const runtimeRedFixtureCommand = '/usr/bin/claude'
export const runtimeRedFixtureForbiddenEnv = fixtureMarker('forbidden-env')

export const runtimeRedSensitiveValues = [
  pairingFixtureBearer,
  pairingFixtureNonce,
  runtimeRedFixtureApiKey,
  runtimeRedFixtureCredential,
  runtimeRedRejectedCredential,
  runtimeRedFixtureEndpoint,
  runtimeRedFixtureCommand,
] as const
