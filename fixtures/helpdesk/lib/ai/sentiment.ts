import OpenAI from 'openai';

const openai = new OpenAI();

const SENTIMENT_PROMPT = 'Rate the sentiment of the customer message. Reply with only one word: positive, neutral or negative.';

export async function sentimentCheck(messages: string[]) {
  return Promise.all(messages.map(async text => {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 5,
      messages: [
        { role: 'system', content: SENTIMENT_PROMPT },
        { role: 'user', content: text },
      ],
    });
    return res.choices[0].message.content?.trim().toLowerCase() ?? 'neutral';
  }));
}
