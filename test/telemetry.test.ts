import { expect, mock, test } from 'bun:test'
import { createApp } from '../src'
import { readConfig } from '../src/config/env'
import { collectOllama } from '../src/services/ollama'
import { macBattery, macMemory } from '../src/services/system'
import { collectTelemetry, createTelemetryService } from '../src/services/telemetry'
import type { SystemTelemetry, Telemetry } from '../src/types/telemetry'

const ollamaUrl = new URL('http://127.0.0.1:11434')
const offline = { reachable: false, models: [] }

const system: SystemTelemetry = {
  system: {
    os: 'macOS',
    version: '26.1',
    hardwareModel: 'Mac16,1',
    cpuModel: 'Apple M4',
    cpuCores: 10,
    uptimeSeconds: 3600,
  },
  cpu: { utilisationPercent: 10, loadAverage: [1, 0.8, 0.5] },
  memory: { totalBytes: 1024, availableBytes: 512, usedBytes: 512, utilisationPercent: 50 },
  battery: { percent: 90, acConnected: true, isCharging: false, cycleCount: 32 },
  storage: { totalBytes: 2048, availableBytes: 1024, usedBytes: 1024, utilisationPercent: 50 },
}

const sample: Telemetry = { ...system, ollama: offline, timestamp: '2026-01-01T00:00:00.000Z' }

test('serves health and returns JSON for unknown routes', async () => {
  const app = createApp(async () => sample)

  const health = await app.request('/health')
  expect(health.status).toBe(200)
  expect(health.headers.get('cache-control')).toBe('no-store')
  const body = await health.json()
  expect(body).toEqual({
    status: 'ok',
    uptimeSeconds: expect.any(Number),
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    timestamp: expect.any(String),
  })
  expect(Number.isFinite(Date.parse(body.timestamp))).toBe(true)

  const missing = await app.request('/missing')
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  })

  const write = await app.request('/telemetry', { method: 'POST' })
  expect(write.ok).toBe(false)
})

test('reuses a collection for 5 seconds after completion and refreshes at expiry', async () => {
  let time = 0
  const collect = mock(async () => {
    time += 1000
    return { ...sample, timestamp: new Date(time).toISOString() }
  })
  const getTelemetry = createTelemetryService(collect, () => time)

  const first = await getTelemetry()
  time = 5999
  expect(await getTelemetry()).toBe(first)
  expect(collect).toHaveBeenCalledTimes(1)

  time = 6000
  expect((await getTelemetry()).timestamp).not.toBe(first.timestamp)
  expect(collect).toHaveBeenCalledTimes(2)
})

test('concurrent HTTP requests share a single in-flight collection', async () => {
  const pending = Promise.withResolvers<Telemetry>()
  const started = Promise.withResolvers<void>()
  const collect = mock(() => {
    started.resolve()
    return pending.promise
  })
  const app = createApp(createTelemetryService(collect))
  const first = app.request('/telemetry')
  await started.promise
  const second = app.request('/telemetry')
  pending.resolve(sample)

  for (const response of await Promise.all([first, second])) {
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(sample)
  }
  expect(collect).toHaveBeenCalledTimes(1)
})

test('centralizes errors without leaking details and retries failed collections', async () => {
  let attempts = 0
  const collect = mock(async () => {
    if (++attempts === 1) throw new Error('Unexpected file /Users/private-user')
    return sample
  })
  const app = createApp(createTelemetryService(collect))

  const failure = await app.request('/telemetry')
  expect(failure.status).toBe(500)
  expect(await failure.json()).toEqual({
    error: { code: 'INTERNAL_ERROR', message: 'Unable to complete the request' },
  })

  const retry = await app.request('/telemetry')
  expect(retry.status).toBe(200)
  expect(await retry.json()).toEqual(sample)
  expect(collect).toHaveBeenCalledTimes(2)
})

test('system metrics stay available when Ollama is offline', async () => {
  const systemResult = Promise.withResolvers<SystemTelemetry>()
  const readOllama = mock(async () => {
    throw new Error('connection refused')
  })
  const app = createApp(() => collectTelemetry(
    () => systemResult.promise,
    () => collectOllama(ollamaUrl, readOllama),
  ))

  const response = app.request('/telemetry')
  await Promise.resolve()
  expect(readOllama).toHaveBeenCalledTimes(1)
  systemResult.resolve(system)
  const result = await response
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ ...system, ollama: offline, timestamp: expect.any(String) })
})

test('projects Ollama models onto public fields and discards private identifiers', async () => {
  const request = mock(async () => Response.json({
    hostname: 'mac.internal',
    models: [
      {
        name: 'mac.internal/private-user/qwen2.5:7b',
        digest: 'private-digest',
        size: 200,
        size_vram: 100,
        details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M', parent_model: '/Users/me' },
      },
      { name: '/Users/private-user/model', size: '200', size_vram: -1, path: '/models/local' },
      { name: '192.168.1.1', model: 'anything:mac.internal' },
      null,
    ],
  }))

  expect(await collectOllama(ollamaUrl, request)).toEqual({
    reachable: true,
    models: [
      { name: 'qwen2.5:7b', parameterSize: '7.6B', quantisationLevel: 'Q4_K_M', sizeBytes: 200, vramBytes: 100 },
      { name: null, parameterSize: null, quantisationLevel: null, sizeBytes: null, vramBytes: null },
      { name: null, parameterSize: null, quantisationLevel: null, sizeBytes: null, vramBytes: null },
    ],
  })
  expect(request.mock.calls).toHaveLength(1)
})

test('treats non-success and malformed Ollama responses as unavailable', async () => {
  expect(await collectOllama(ollamaUrl, async () => new Response(null, { status: 503 }))).toEqual(offline)
  expect(await collectOllama(ollamaUrl, async () => Response.json({ models: {} }))).toEqual(offline)
  expect(await collectOllama(ollamaUrl, async () => new Response('not JSON'))).toEqual(offline)
})

test('aborts a stalled Ollama request', async () => {
  let requestedUrl: string | undefined
  let redirect: RequestRedirect | undefined
  let aborted = false
  const result = await collectOllama(ollamaUrl, async (input, init) => {
    requestedUrl = String(input)
    redirect = init.redirect
    const signal = init.signal
    if (!signal) throw new Error('Missing timeout signal')
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted = true
      reject(signal.reason)
    }, { once: true }))
  })

  expect(requestedUrl).toBe('http://127.0.0.1:11434/api/ps')
  expect(redirect).toBe('error')
  expect(aborted).toBe(true)
  expect(result).toEqual(offline)
})

test('macOS memory excludes reclaimable memory and uses the reported page size', () => {
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               30.',
    'Anonymous pages:                          50.',
    'Pages wired down:                         10.',
    'Pages occupied by compressor:              5.',
    'Pages purgeable:                          15.',
    'File-backed pages:                        20.',
  ].join('\n')
  const total = 100 * 16384
  expect(macMemory(total, vmStat)).toEqual({
    totalBytes: total,
    usedBytes: 50 * 16384,
    availableBytes: 50 * 16384,
    utilisationPercent: 50,
  })
  expect(macMemory(total, vmStat.replace(/Pages purgeable.+\n/, ''))).toEqual({
    totalBytes: total,
    usedBytes: null,
    availableBytes: null,
    utilisationPercent: null,
  })
})

test('macOS battery distinguishes charging from AC connection and handles missing fields', () => {
  const ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=123) 80%; not charging; present: true"
  const unplugged = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123) 0%; discharging; present: true"
  expect(macBattery(ac, '    "CycleCount" = 32\n    "Serial" = "private"')).toEqual({
    percent: 80, isCharging: false, acConnected: true, cycleCount: 32,
  })
  expect(macBattery(unplugged, null)).toEqual({
    percent: 0, isCharging: false, acConnected: false, cycleCount: null,
  })
  expect(macBattery(null, null)).toEqual({
    percent: null, isCharging: null, acConnected: null, cycleCount: null,
  })
})

test('validates environment configuration', () => {
  expect(readConfig({})).toEqual({ port: 3001, ollamaUrl })
  expect(readConfig({ PORT: '4001', OLLAMA_URL: 'https://ollama.example' })).toEqual({
    port: 4001,
    ollamaUrl: new URL('https://ollama.example'),
  })
  expect(() => readConfig({ PORT: '65536' })).toThrow('PORT')
  expect(() => readConfig({ PORT: '1e3' })).toThrow('PORT')
  expect(() => readConfig({ OLLAMA_URL: 'file:///etc/passwd' })).toThrow('OLLAMA_URL')
  expect(() => readConfig({ OLLAMA_URL: 'http://user:secret@127.0.0.1' })).toThrow('OLLAMA_URL')
})
