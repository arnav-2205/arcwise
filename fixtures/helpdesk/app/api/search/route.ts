import { authGuard } from '../../../lib/authGuard';
import { db } from '../../../lib/db/client';

export async function GET(req: Request) {
  await authGuard(req);
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return Response.json(await db.query('SELECT id, title FROM articles WHERE title ILIKE $1 LIMIT 20', [`%${q}%`]));
}
