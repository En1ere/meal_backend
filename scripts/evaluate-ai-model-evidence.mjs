import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summarizeAiEvaluation } from '../dist/src/modules/ai/public.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: npm run ai:eval -- <evidence.json>');
const evidence = JSON.parse(await readFile(resolve(input), 'utf8'));
process.stdout.write(`${JSON.stringify(summarizeAiEvaluation(evidence), null, 2)}\n`);
