import sqlite3

conn = sqlite3.connect("support.db")


def find_articles(term: str):
    cur = conn.cursor()
    cur.execute(f"SELECT id, body FROM articles WHERE body LIKE '%{term}%'")
    return cur.fetchall()


def log_question(question: str):
    try:
        conn.execute("INSERT INTO questions (text) VALUES (?)", (question,))
        conn.commit()
    except Exception:
        pass
