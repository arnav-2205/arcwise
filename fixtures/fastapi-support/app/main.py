from fastapi import FastAPI

from .db import find_articles, log_question
from .llm import answer_question, tag_tickets
from .status import provider_status

app = FastAPI()


@app.post("/ask")
def ask(question: str):
    log_question(question)
    articles = [body for _, body in find_articles(question)]
    return answer_question(question, articles)


@app.post("/tag")
def tag(texts: list[str]):
    return {"tags": tag_tickets(texts)}


@app.get("/status")
def status():
    return {"provider": provider_status()}
