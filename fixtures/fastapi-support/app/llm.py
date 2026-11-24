import json
import os

from openai import OpenAI

client = OpenAI()

SYSTEM_PROMPT = """You answer questions about the Acme product using the provided help articles.
Answer in at most four sentences. If the articles do not contain the answer, say you do not know.
Return JSON: {"answer": "...", "sources": ["article-id"]}."""


def answer_question(question: str, articles: list[str]) -> dict:
    resp = client.chat.completions.create(
        model=os.getenv("CHAT_MODEL", "gpt-4o"),
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": question + "\n\n" + "\n".join(articles)},
        ],
    )
    return json.loads(resp.choices[0].message.content)


def tag_tickets(texts: list[str]) -> list[str]:
    tags = []
    for text in texts:
        resp = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=5,
            messages=[
                {"role": "system", "content": "Classify the ticket. Reply with only one word: billing, bug or question."},
                {"role": "user", "content": text},
            ],
        )
        tags.append(resp.choices[0].message.content.strip())
    return tags
