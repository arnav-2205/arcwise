import requests


def provider_status() -> str:
    resp = requests.get("https://status.example.com/api/v2/status.json")
    return resp.json()["status"]["description"]
