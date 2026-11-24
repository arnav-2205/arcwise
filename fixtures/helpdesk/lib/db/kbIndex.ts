import { db } from './client';

export async function saveVector(id: string, vector: number[]) {
  await db.query('UPDATE articles SET embedding = $1 WHERE id = $2', [JSON.stringify(vector), id]);
}
