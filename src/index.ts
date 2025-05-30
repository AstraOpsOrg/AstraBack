// src/index.ts
import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  const greeting = Bun.env.NODE_ENV === 'development' 
    ? 'Hello from DEVELOPMENT MODE (localhost)!' 
    : 'Hello from backend.astraops.pro via Caddy & Docker!';
  return c.text(greeting)
})

// Puerto: Lee de la variable de entorno APP_INTERNAL_PORT, o PORT, o usa 3000 por defecto.
// En producción (Docker), no estableceremos APP_INTERNAL_PORT, así que usará 3000.
// En desarrollo, puedes establecerlo si quieres otro puerto.
const internalAppPort = parseInt(
  process.env.APP_INTERNAL_PORT || process.env.PORT || "3000"
);

// Hostname: Lee de la variable de entorno APP_HOSTNAME.
// En producción (Docker), queremos "0.0.0.0".
// En desarrollo local, "localhost" (o 127.0.0.1) es lo usual.
// Si APP_HOSTNAME no está definida, Bun.serve por defecto suele usar "0.0.0.0" o "localhost"
// dependiendo del contexto, pero ser explícito es mejor.
const appHostname = process.env.APP_HOSTNAME || (process.env.NODE_ENV === 'development' ? "localhost" : "0.0.0.0");

console.log(`AstraBack (Hono) is preparing to listen on http://${appHostname}:${internalAppPort}`);
console.log(`NODE_ENV is: ${process.env.NODE_ENV}`); // Útil para depurar

export default {
  port: internalAppPort,
  hostname: appHostname, // Usa el hostname configurado
  fetch: app.fetch,
  // Opcional: puedes añadir un manejador de errores aquí también si Bun lo soporta en este formato de export
  // error(error) {
  //   console.error("Bun.serve error:", error);
  //   return new Response("Internal Server Error", { status: 500 });
  // },
}

// El console.log de "listening" lo hará Bun automáticamente cuando use este export default.
// Si usaras Bun.serve() explícitamente, lo pondrías después de llamar a Bun.serve().