import type { ErrorHandler, NotFoundHandler } from 'hono'

export const handleError: ErrorHandler = (_error, c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: { code: 'INTERNAL_ERROR', message: 'Unable to complete the request' },
  }, 500)
}

export const handleNotFound: NotFoundHandler = c => {
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  }, 404)
}
