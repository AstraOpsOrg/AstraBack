// src/index.ts
import { Hono } from 'hono'
import { logger } from 'hono/logger';
import { customAuthMiddleware } from '@/src/utils/Auth';
import loadV1 from '@/src/apis/v1';

const app = new Hono()
app.use('*', logger())
app.use('*', customAuthMiddleware)

loadV1(app)

const internalAppPort = parseInt(Bun.env.PORT || "3000");
const appHostname = Bun.env.NODE_ENV === 'development' ? "localhost" : "0.0.0.0";

console.log(`NODE_ENV is: ${Bun.env.NODE_ENV}`);

export default {
  port: internalAppPort,
  hostname: appHostname,
  fetch: app.fetch,
}