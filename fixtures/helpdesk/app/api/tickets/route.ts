import { authGuard } from '../../../lib/authGuard';
import { listByStatus } from '../../../lib/db/ticketRepo';
import { suggestReply } from '../../../lib/replyService';

export async function GET(req: Request) {
  await authGuard(req);
  const status = new URL(req.url).searchParams.get('status') ?? 'open';
  return Response.json(await listByStatus(status));
}

export async function POST(req: Request) {
  await authGuard(req);
  const { ticketId } = await req.json();
  return Response.json(await suggestReply(ticketId));
}
