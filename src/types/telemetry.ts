export interface SystemTelemetry {
  system: {
    os: string | null
    version: string | null
    hardwareModel: string | null
    cpuModel: string | null
    cpuCores: number | null
    uptimeSeconds: number | null
  }
  cpu: {
    utilisationPercent: number | null
    loadAverage: [number, number, number] | null
  }
  memory: {
    totalBytes: number | null
    usedBytes: number | null
    availableBytes: number | null
    utilisationPercent: number | null
  }
  battery: {
    percent: number | null
    isCharging: boolean | null
    acConnected: boolean | null
    cycleCount: number | null
  }
  storage: {
    totalBytes: number | null
    usedBytes: number | null
    availableBytes: number | null
    utilisationPercent: number | null
  }
}

export interface OllamaTelemetry {
  reachable: boolean
  models: Array<{
    name: string | null
    parameterSize: string | null
    quantisationLevel: string | null
    sizeBytes: number | null
    vramBytes: number | null
  }>
}

export interface Telemetry extends SystemTelemetry {
  ollama: OllamaTelemetry
  timestamp: string
}
