// Shows a contract exactly as it leaves local redaction (regex + DictaBERT NER), with no analysis,
// no database, and no cloud request. Usage: npx tsx scripts/ner-preview.ts <contract.pdf> [out.txt]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactClauses } from "../src/modules/analyses/anonymization.service.js";
import { extractPdf } from "../src/modules/contracts/pdf-extraction.service.js";

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error("Usage: npx tsx scripts/ner-preview.ts <contract.pdf> [out.txt]");
  process.exit(1);
}

const contract = await extractPdf(await readFile(input));
const redaction = await redactClauses(contract.clauses);

const report = [
  `File: ${path.basename(input)}`,
  `Mode: ${redaction.mode}${redaction.model ? ` (${redaction.model})` : ""}`,
  `Clauses: ${redaction.clauses.length}, details removed: ${redaction.redactedEntityCount}`,
  "",
  ...redaction.clauses.map((clause, index) => {
    const before = contract.clauses[index]!.text;
    const label = clause.sectionLabel ? `${clause.id} (§${clause.sectionLabel})` : clause.id;
    return before === clause.text
      ? `── ${label}\n${clause.text}\n`
      : `── ${label}  [CHANGED]\nBEFORE: ${before}\nAFTER:  ${clause.text}\n`;
  }),
].join("\n");

console.log(report);
if (output) {
  await writeFile(output, report, "utf8");
  console.log(`Saved to ${output}`);
}
