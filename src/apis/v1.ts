import { Hono } from "hono"
const basePath = '/v1'

function loadV1(app: Hono) {
  app.get(`${basePath}`, (c) => {
    return c.json({ message: 'AstraOps API v1' })
  })

  app.get(`${basePath}/platform`, (c) => {
    return c.json({ message: 'AstraOps API v1' })
  })
}

export default loadV1
