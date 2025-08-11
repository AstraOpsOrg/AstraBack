import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { customAuthMiddleware } from '@/utils/Auth'
import loadV1 from '@/apis/v1'

const app = new Hono()
app.use('*', logger())

// Apply auth middleware 
app.use('*', customAuthMiddleware)

loadV1(app)

const internalAppPort = parseInt(Bun.env.PORT || '3000')
const appHostname = Bun.env.NODE_ENV === 'development' ? 'localhost' : '0.0.0.0'

console.log(`Starting AstraOps Backend server...`)
console.log(`NODE_ENV: ${Bun.env.NODE_ENV}`)

const server = Bun.serve({
  port: internalAppPort,
  hostname: appHostname,
  fetch: app.fetch,
  idleTimeout: 120 // seconds; keep SSE connections alive (> heartbeat interval)
})

console.log(`AstraOps Backend is running on http://${server.hostname}:${server.port}`)

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, gracefully shutting down...')
  server.stop()
  console.log('Server stopped gracefully')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, gracefully shutting down...')
  server.stop()
  console.log('Server stopped gracefully')
  process.exit(0)
})
