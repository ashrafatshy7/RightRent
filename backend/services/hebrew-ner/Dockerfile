FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/opt/huggingface

WORKDIR /service
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

ARG PII_NER_MODEL=dicta-il/dictabert-ner
ENV PII_NER_MODEL=${PII_NER_MODEL}
RUN python -c "from transformers import AutoModelForTokenClassification, AutoTokenizer; AutoTokenizer.from_pretrained('${PII_NER_MODEL}'); AutoModelForTokenClassification.from_pretrained('${PII_NER_MODEL}')"

COPY app.py ./
EXPOSE 8001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
