# Local Hebrew NER sidecar

This service runs `dicta-il/dictabert-ner` locally and returns only redacted text to the
Node.js backend. Do not expose port 8001 publicly. Set the same `PII_NER_TOKEN` in both
processes and keep the endpoint on loopback or a private container network.

```bash
docker build -t rightrent-hebrew-ner .
docker run --rm -p 127.0.0.1:8001:8001 \
  -e PII_NER_TOKEN=replace-with-a-long-random-token \
  rightrent-hebrew-ner
```

The DictaBERT NER model is licensed CC BY 4.0. Preserve the model attribution in deployed
product documentation: `dicta-il/dictabert-ner`, DICTA — The Israel Center for Text Analysis.
