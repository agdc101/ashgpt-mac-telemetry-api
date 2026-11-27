export function readConfig(env: Record<string, string | undefined>) {
  const portValue = env.PORT ?? '3001'
  const port = Number(portValue)
  if (!/^\d+$/.test(portValue) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535')
  }

  const baseUrl = URL.parse(env.OLLAMA_URL ?? 'http://127.0.0.1:11434')
  if (
    !baseUrl || !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username || baseUrl.password || baseUrl.pathname !== '/' ||
    baseUrl.search || baseUrl.hash
  ) {
    throw new Error('OLLAMA_URL must be an HTTP(S) origin without credentials')
  }

  return { port, ollamaUrl: baseUrl }
}
