import { Hono } from 'hono'
import { readConfig } from './config/env'
import { handleError, handleNotFound } from './middleware/error-handler'
import { healthRoute } from './routes/health'
import { telemetryRoute } from './routes/telemetry'
import { collectOllama } from './services/ollama'
import { collectSystem } from './services/system'
import { collectTelemetry, createTelemetryService } from './services/telemetry'
import type { Telemetry } from './types/telemetry'

export function createApp(getTelemetry: () => Promise<Telemetry>) {
  return new Hono()
    .onError(handleError)
    .notFound(handleNotFound)
    .route('/health', healthRoute)
    .route('/telemetry', telemetryRoute(getTelemetry))
}

const config = readConfig(process.env)
const app = createApp(createTelemetryService(
  () => collectTelemetry(collectSystem, () => collectOllama(config.ollamaUrl)),
))

export type AppType = typeof app

export default {
  hostname: '127.0.0.1',
  development: false,
  port: config.port,
  fetch: app.fetch,
}
