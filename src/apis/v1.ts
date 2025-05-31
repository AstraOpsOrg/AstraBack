import { Hono } from "hono"

function loadV1(app: Hono) {
  app.get('/', (c) => {
    return c.json({ message: 'AstraOps API v1' })
  })
}

export default loadV1
