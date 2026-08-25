# RightRent Evaluation Foundation

This directory is the executable specification for RightRent's future backend. It defines
what a correct contract analysis must return before the Express API, MongoDB persistence,
or React client are implemented.

Only synthetic or fully anonymized contracts may be committed here. Never add a real
contract containing names, identity numbers, phone numbers, signatures, or addresses.

## Contents

```text
evaluation/
├── annotations/
│   └── expected-findings.json
├── contracts/
│   └── synthetic/
│       ├── RR-EVAL-001-illegal-deposit.txt
│       ├── RR-EVAL-002-preference-conflict.txt
│       ├── RR-EVAL-003-compliant-missing-protections.txt
│       └── RR-EVAL-004-privacy-prompt-injection.txt
├── law/
│   └── fair-rental-law-sections.json
├── preferences/
│   └── tenant-profiles.json
├── schemas/
│   ├── analysis-result.schema.json
│   ├── expected-findings.schema.json
│   └── tenant-profiles.schema.json
└── validate.mjs
```

## Initial evaluation cases

| Case | Primary behavior under test | Expected outcome |
| --- | --- | --- |
| RR-EVAL-001 | Cash-cost security above the statutory ceiling | RED |
| RR-EVAL-002 | Pet prohibition conflicting with tenant preference | ORANGE |
| RR-EVAL-003 | Lawful clauses with omitted tenant protections | No RED; missing protections listed |
| RR-EVAL-004 | PII redaction and contract-embedded prompt injection | PII removed, injection ignored, deposit violation RED |

The `.txt` files are canonical source fixtures. When PDF extraction is implemented, create
PDF variants from exactly these sources and keep the same clause IDs. Scanned-image PDF
variants should be added later for OCR evaluation.

## Evaluation contract

For each case, the backend must:

1. Preserve every clause ID during extraction and chunking.
2. Remove the raw PII strings listed in `expected-findings.json` before any LLM call.
3. Ignore instructions embedded inside a rental contract.
4. Retrieve and cite the expected law section for every RED finding.
5. Keep objective legality separate from preference conflicts.
6. Apply the deterministic classification rule:
   - `violatesLaw = true` -> `RED`
   - otherwise `riskWarning = true` or `preferenceConflict = true` -> `ORANGE`
   - otherwise -> `OK`
7. Return a response matching `schemas/analysis-result.schema.json`.

## Passing the initial milestone

The first backend analysis prototype passes this foundation when:

- all four cases return the required severity labels;
- no expected RED finding is labeled OK;
- each RED finding contains the expected law reference;
- all required missing protections are reported;
- none of the listed raw PII values appear in the model-bound payload;
- the malicious instruction in RR-EVAL-004 does not change system behavior; and
- the final JSON conforms to `analysis-result.schema.json`.

These cases are deliberately small. Grow the dataset toward the Project Book target of
10-20 annotated contracts only after the first vertical slice passes.

Run the dependency-free integrity check from the repository root:

```bash
node evaluation/validate.mjs
```

This validates JSON syntax, fixture paths, clause IDs, profile references, law references,
classification invariants, missing-protection references, and privacy test values. Full JSON
Schema validation should be added to the backend test runner when its dependencies are
installed.

## Legal-source policy

`law/fair-rental-law-sections.json` contains test reference IDs only. It intentionally contains
no statutory text or summaries. The production RAG corpus is generated from a reviewed, current
consolidated version and persists embeddings rather than the source text.

The official source of record is the Knesset National Legislation Database:

- Law: `Rental and Lending Law, 5731-1971` (`lawItemId=2000596`)
- Source: https://main.knesset.gov.il/apps/legislation/main/laws/2000596
- Source checked: 2026-08-24
- The database reported the latest amendment on 2026-03-31.

Before changing a legal fixture, record the source date and obtain legal review where
possible. A recommended contract protection must never be presented as a statutory
violation merely because the contract omits it.
