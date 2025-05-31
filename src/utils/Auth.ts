import { Context, Next } from 'hono'; 

export async function customAuthMiddleware(c: Context, next: Next) {
  const apiKey = Bun.env.API_KEY;

  if (!apiKey) {
    console.error('CRITICAL: API_KEY environment variable is not set.');
    return c.json({ error: 'Server Configuration Error' }, 500);
  }

  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return c.json({ error: 'Unauthorized: Missing Authorization header' }, 401);
  }

  if (authHeader !== apiKey) {
    return c.json({ error: 'Forbidden: Invalid API Key' }, 403);
  }

  await next();
}
