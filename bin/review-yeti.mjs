#!/usr/bin/env node
import { runEvaluationCli } from '../src/cli/evaluationCli.mjs';

process.exitCode = await runEvaluationCli();
