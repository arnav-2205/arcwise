import { db } from './db/client';

export async function authGuard(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) throw new Response('Unauthorized', { status: 401 });
  const rows = await db.query('SELECT * FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
  if (!rows.length) throw new Response('Unauthorized', { status: 401 });
  return rows[0] as { userId: string; role: string };
}
