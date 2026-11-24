import { db } from './db/client';

const HOURS: Record<string, number> = { high: 4, normal: 24, low: 72 };

export async function startSlaTimer(ticketId: string, urgency: string) {
  try {
    const due = new Date(Date.now() + (HOURS[urgency] ?? 24) * 3600_000);
    await db.query('INSERT INTO sla_jobs (ticket_id, due_at) VALUES ($1, $2)', [ticketId, due.toISOString()]);
  } catch (e) {}
}
