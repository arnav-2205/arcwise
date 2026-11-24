import { classifyTicket } from './ai/classify';
import { routeTicket } from './ai/route';
import { sentimentCheck } from './ai/sentiment';
import { insertTicket } from './db/ticketRepo';
import { startSlaTimer } from './slaTimer';
import { notify } from './notifier';

export interface IncomingEmail { from: string; subject: string; body: string }

export async function createTicket(email: IncomingEmail) {
  const text = `${email.subject}\n\n${email.body}`;
  const { category, urgency } = await classifyTicket(text);
  const team = await routeTicket(text);
  const [mood] = await sentimentCheck([email.body]);
  const ticket = await insertTicket({ from: email.from, subject: email.subject, body: email.body, category, urgency, team, mood });
  await startSlaTimer(ticket.id, urgency);
  await notify(team, `New ${urgency} ticket: ${email.subject}`);
  return ticket;
}
