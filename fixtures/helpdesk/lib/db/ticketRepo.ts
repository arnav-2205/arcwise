import { db } from './client';
import type { Message } from '../ai/draft';

export async function insertTicket(t: Record<string, string>) {
  const rows = await db.query('INSERT INTO tickets (data) VALUES ($1) RETURNING id', [JSON.stringify(t)]);
  return { id: rows[0].id as string };
}

export async function listByStatus(status: string) {
  const q = "SELECT * FROM tickets WHERE status = '" + status + "'";
  return db.query(q);
}

export async function getThread(ticketId: string): Promise<Message[]> {
  return db.query('SELECT * FROM messages WHERE ticket_id = $1 ORDER BY created_at', [ticketId]);
}
