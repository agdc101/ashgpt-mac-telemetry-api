import type { OllamaTelemetry, SystemTelemetry, Telemetry } from '../types/telemetry'

const cacheMs = 5000

export async function collectTelemetry(
  readSystem: () => Promise<SystemTelemetry>,
  readOllama: () => Promise<OllamaTelemetry>,
): Promise<Telemetry> {
  const [system, ollama] = await Promise.all([readSystem(), readOllama()])
  return { ...system, ollama, timestamp: new Date().toISOString() }
}

export function createTelemetryService(collect: () => Promise<Telemetry>, now = () => performance.now()) {
  let cached: { telemetry: Telemetry; expiresAt: number } | undefined
  let inFlight: Promise<Telemetry> | undefined

  return function getTelemetry(): Promise<Telemetry> {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.telemetry)

    inFlight ??= Promise.resolve().then(collect).then(telemetry => {
      cached = { telemetry, expiresAt: now() + cacheMs }
      return telemetry
    }).finally(() => {
      inFlight = undefined
    })

    return inFlight
  }
}
