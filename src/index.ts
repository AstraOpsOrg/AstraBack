// src/index.ts
import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  const greeting = Bun.env.NODE_ENV === 'development' 
    ? 'Hello from localhost!' 
    : 'Hello from backend.astraops.pro!';
  return c.text(greeting)
})

const internalAppPort = parseInt(process.env.PORT || "3000");
const appHostname = process.env.NODE_ENV === 'development' ? "localhost" : "0.0.0.0";

console.log(`NODE_ENV is: ${process.env.NODE_ENV}`);
console.log(`AstraBack is preparing to listen on http://${appHostname}:${internalAppPort}`);

export default {
  port: internalAppPort,
  hostname: appHostname,
  fetch: app.fetch,
}