import os
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator
from transformers import pipeline

MODEL_NAME = os.getenv("PII_NER_MODEL", "dicta-il/dictabert-ner")
SERVICE_TOKEN = os.getenv("PII_NER_TOKEN")
MAX_TEXT_CHARACTERS = 250_000

classifier = pipeline(
    "token-classification",
    model=MODEL_NAME,
    tokenizer=MODEL_NAME,
    aggregation_strategy="simple",
)

app = FastAPI(title="RightRent local Hebrew NER", docs_url=None, redoc_url=None)


class RedactionRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=200)
    minimumConfidence: float = Field(default=0.8, ge=0.5, le=1)

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, texts: list[str]) -> list[str]:
        if any(not text.strip() or len(text) > MAX_TEXT_CHARACTERS for text in texts):
            raise ValueError("Each text must be non-empty and no longer than 250,000 characters")
        return texts


def authorize(token: str | None) -> None:
    if SERVICE_TOKEN and token != SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid service token")


def placeholder_for(label: str) -> str | None:
    normalized = label.removeprefix("B-").removeprefix("I-")
    return {
        "PER": "[PERSON_NAME]",
        "ORG": "[ORGANIZATION]",
        "LOC": "[LOCATION]",
        "GPE": "[LOCATION]",
        "FAC": "[LOCATION]",
    }.get(normalized)


def redact_text(text: str, minimum_confidence: float) -> tuple[str, int]:
    raw_entities: list[dict[str, Any]] = classifier(text)
    spans: list[tuple[int, int, str]] = []
    for entity in raw_entities:
        placeholder = placeholder_for(str(entity.get("entity_group", entity.get("entity", ""))))
        score = float(entity.get("score", 0))
        start = int(entity.get("start", -1))
        end = int(entity.get("end", -1))
        if placeholder and score >= minimum_confidence and 0 <= start < end <= len(text):
            spans.append((start, end, placeholder))

    selected: list[tuple[int, int, str]] = []
    for span in sorted(spans, key=lambda item: (item[0], -(item[1] - item[0]))):
        if selected and span[0] < selected[-1][1]:
            continue
        selected.append(span)

    redacted = text
    for start, end, placeholder in reversed(selected):
        redacted = f"{redacted[:start]}{placeholder}{redacted[end:]}"
    return redacted, len(selected)


@app.get("/health")
def health(x_ner_token: str | None = Header(default=None)) -> dict[str, object]:
    authorize(x_ner_token)
    return {"ready": True, "model": MODEL_NAME}


@app.post("/redact")
def redact(
    request: RedactionRequest,
    x_ner_token: str | None = Header(default=None),
) -> dict[str, object]:
    authorize(x_ner_token)
    items = []
    for text in request.texts:
        redacted, entity_count = redact_text(text, request.minimumConfidence)
        items.append({"text": redacted, "entityCount": entity_count})
    return {"model": MODEL_NAME, "items": items}
