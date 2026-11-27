import { Hono } from 'hono'
import { version } from '../../package.json'

export const healthRoute = new Hono().get('/', c => {
  c.header('Cache-Control', 'no-store')
  return c.json({
    status: 'ok' as const,
    uptimeSeconds: process.uptime(),
    version,
    timestamp: new Date().toISOString(),
  })
})
