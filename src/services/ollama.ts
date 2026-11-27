import type { OllamaTelemetry } from '../types/telemetry'

const timeoutMs = 1500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bytes(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function modelName(value: unknown) {
  if (typeof value !== 'string' || value.startsWith('/') || /[\\\s]/.test(value)) return null

  // Namespaces and registries may contain account names or private hostnames.
  const name = value.split('/').at(-1) ?? ''
  const namePattern = /^[a-z\d][a-z\d_-]*(?:\.\d[a-z\d_-]*)*(?::[a-z\d][a-z\d_-]*(?:\.\d[a-z\d_-]*)*)?$/i
  return name.length <= 128 && namePattern.test(name) && !/(?:^|:)\d+(?:\.\d+){3}(?:[:_-]|$)/.test(name)
    ? name
    : null
}

function safeDetail(value: unknown, pattern: RegExp) {
  return typeof value === 'string' && pattern.test(value) ? value : null
}

export async function collectOllama(baseUrl: URL, request: (url: URL, init: RequestInit) => Promise<Response> = fetch): Promise<OllamaTelemetry> {
  try {
    const response = await request(new URL('/api/ps', baseUrl), {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { reachable: false, models: [] }

    const payload: unknown = await response.json()
    if (!isRecord(payload) || !Array.isArray(payload.models)) {
      return { reachable: false, models: [] }
    }

    const models = payload.models.filter(isRecord).map(model => {
      const details = isRecord(model.details) ? model.details : {}
      return {
        name: modelName(model.name) ?? modelName(model.model),
        parameterSize: safeDetail(details.parameter_size, /^\d{1,6}(?:\.\d{1,3})? ?[KMBT]$/i),
        quantisationLevel: safeDetail(details.quantization_level, /^[a-z\d][a-z\d_]{0,31}$/i),
        sizeBytes: bytes(model.size),
        vramBytes: bytes(model.size_vram),
      }
    })

    return { reachable: true, models }
  } catch {
    return { reachable: false, models: [] }
  }
}
