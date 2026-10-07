#!/usr/bin/env node
/**
 * dsh-sbie-run — DSH sandbox runner backed by Sandboxie-Plus.
 *
 * Wire it into DSH by pointing the `sandbox` plugin row at this file:
 *
 *   - id: sandbox
 *     name: '@deepseek-ai/dsh-sandbox-local'
 *     config:
 *       runnerCommand: ['<node.exe>', '<plugin>/bin/dsh-sbie-run.mjs']
 *       runnerFailureSignatures: ['dsh-sbie-run: ']
 *
 * See README.zh.md for the full wiring block and the semantics.
 */
import { manage } from "../lib/cli.mjs";
import { main } from "../lib/run.mjs";

const argv = process.argv.slice(2);
if (argv[0] === "--manage") {
  process.exitCode = manage(argv.slice(1));
} else {
  await main(argv);
}
