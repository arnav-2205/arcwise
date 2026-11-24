import OpenAI from 'openai';
import { saveVector } from '../db/kbIndex';

const openai = new OpenAI();

export async function embedArticles(articles: { id: string; body: string }[]) {
  for (const article of articles) {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: article.body,
    });
    await saveVector(article.id, res.data[0].embedding);
  }
}
