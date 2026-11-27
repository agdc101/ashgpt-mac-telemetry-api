import { Hono } from 'hono'
import type { Telemetry } from '../types/telemetry'

export function telemetryRoute(getTelemetry: () => Promise<Telemetry>) {
  return new Hono().get('/', async c => {
    c.header('Cache-Control', 'no-store')
    return c.json(await getTelemetry())
  })
}
