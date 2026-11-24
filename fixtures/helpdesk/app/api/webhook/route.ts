import { authGuard } from '../../../lib/authGuard';
import { createTicket } from '../../../lib/ticketService';
import { notify } from '../../../lib/notifier';

export async function POST(req: Request) {
  await authGuard(req);
  const email = await req.json();
  const ticket = await createTicket(email);
  notify('ops', `Ticket ${ticket.id} created from webhook`);
  return new Response(null, { status: 202 });
}
