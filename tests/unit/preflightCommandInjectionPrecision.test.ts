import { describe, expect, it } from 'vitest';
import { createPreflightDiffReviewTool } from '../../src/mcp/server/tools/preflightDiffReview';

async function findCommandInjection(addedLine: string, filePath = 'src/command.ts') {
  const result = await createPreflightDiffReviewTool().execute({
    repo: 'example/repository',
    diff: `diff --git a/${filePath} b/${filePath}
--- a/${filePath}
+++ b/${filePath}
@@ -1,0 +1,1 @@
+${addedLine}
`,
  });
  const textContent = result.content.find((content) => content.type === 'text');
  if (!textContent || textContent.type !== 'text') throw new Error('Preflight returned no text result');
  const payload = JSON.parse(textContent.text);
  const finding = payload.findings.find((finding: { finding_id: string }) =>
    finding.finding_id.startsWith('pref-cmdi-')
  );
  if (finding) expect(payload.eligible_to_ship).toBe(false);
  return finding;
}

describe('preflight command injection static screening precision', () => {
  it.each([
    {
      label: 'keyword property division cannot swallow a later shell call',
      line: 'const ratio = obj.return / 2; child_process.exec(req.query.command); const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'a command executed inside a template substitution remains P0',
      line: 'const rendered = `${child_process.exec(req.query.command)}`;',
      expected: true,
    },
    {
      label: 'a keyword-named method result is divided rather than starting a regex',
      line: 'const ratio = obj.if(enabled) / 2; child_process.exec(req.query.command); const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'an optional keyword property does not turn division into a regex',
      line: 'const ratio = obj?.return / 2; child_process.exec(req.query.command); const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'postfix increment does not swallow a later shell call between divisions',
      line: 'const ratio = count++ / 2; child_process.exec(req.query.command); const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'postfix decrement does not swallow a later shell call between divisions',
      line: 'const ratio = count-- / 2; child_process.exec(req.query.command); const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'ordinary keyword property division contains no command invocation',
      line: 'const ratio = obj.return / 2; const next = 1 / 2;',
      expected: false,
    },
    {
      label: 'a true return-statement regex keeps call-looking pattern text opaque',
      line: 'function matches(input) { return /exec(req.query.command)/.test(input); }',
      expected: false,
    },
    {
      label: 'a true control-statement regex keeps call-looking pattern text opaque',
      line: 'if (enabled) /exec(req.query.command)/.test(input);',
      expected: false,
    },
    {
      label: 'nested executable templates retain their live shell call',
      line: 'const rendered = `outer ${`inner ${child_process.exec(req.query.command)}`}`;',
      expected: true,
    },
    {
      label: 'an intervening template reassignment invalidates the regex receiver exemption',
      line: 'let runner = /x/; const rendered = `${runner = child_process}`; runner.exec(req.query.command);',
      expected: true,
    },
    {
      label: 'an intervening nested-template method mutation invalidates the regex receiver exemption',
      line: 'const runner = /x/; const rendered = `${`${runner.exec = child_process.exec}`}`; runner.exec(req.query.command);',
      expected: true,
    },
    {
      label: 'a nonexecuting template mentioning the regex binding does not mutate it',
      line: 'const runner = /x/; const example = `runner.exec = child_process.exec`; runner.exec(req.query.command);',
      expected: false,
    },
    {
      label: 'a live nested shell call is still inspected when the enclosing regex exec is exempt',
      line: 'const rendered = /x/.exec(`${child_process.exec(req.query.command)}`);',
      expected: true,
    },
    {
      label: 'object braces and quoted closing delimiters cannot terminate a live substitution',
      line: 'const rendered = `${({ note: "} `", nested: { value: child_process.exec(req.query.command) } }).nested.value}`;',
      expected: true,
    },
    {
      label: 'a live arrow-function body inside a substitution retains the shell call',
      line: 'const rendered = `${(() => { const note = "}"; return child_process.exec(req.query.command); })()}`;',
      expected: true,
    },
    {
      label: 'regex closing braces inside an expression do not end the substitution',
      line: 'const rendered = `${/[}]/.test(value) ? child_process.exec(req.query.command) : ""}`;',
      expected: true,
    },
    {
      label: 'comment delimiters inside an expression cannot hide a later live call',
      line: 'const rendered = `${/* } ` exec(req.command) */ child_process.exec(req.query.command)}`;',
      expected: true,
    },
    {
      label: 'a second live substitution is still scanned after nonexecuting call text',
      line: 'const rendered = `${value} literal exec(req.query.command) ${child_process.exec(req.body.command)}`;',
      expected: true,
    },
    {
      label: 'nonexecuting template text is not blanket-scanned for calls',
      line: 'const example = `child_process.exec(req.query.command)`;',
      expected: false,
    },
    {
      label: 'a quoted call-looking expression is a string rather than a command',
      line: 'const rendered = `${"child_process.exec(req.query.command)"}`;',
      expected: false,
    },
    {
      label: 'call-looking text in a nested literal template remains nonexecuting',
      line: 'const rendered = `outer ${`child_process.exec(req.query.command)`}`;',
      expected: false,
    },
    {
      label: 'an escaped template substitution is literal text',
      line: 'const example = `\\${child_process.exec(req.query.command)}`;',
      expected: false,
    },
    {
      label: 'an escaped backslash still permits the following live substitution',
      line: 'const rendered = `\\\\${child_process.exec(req.query.command)}`;',
      expected: true,
    },
    {
      label: 'an escaped backtick does not close the template before its live substitution',
      line: 'const rendered = `literal \\` ${child_process.exec(req.query.command)}`;',
      expected: true,
    },
    {
      label: 'a comment containing a call inside an expression stays nonexecuting',
      line: 'const rendered = `${/* exec(req.query.command) */ value}`;',
      expected: false,
    },
    {
      label: 'a complete live call is not discarded when the enclosing template continues beyond the line',
      line: 'const rendered = `${child_process.exec(req.query.command)',
      expected: true,
    },
    {
      label: 'a regex literal exec with arithmetic arguments is not a shell command',
      filePath: 'src/mcp/server/tools/preflightDiffReview.ts',
      line: String.raw`const pythonStringPrefix = language === 'python' ? /^(?:f|fr|rf)(?=["'])/i.exec(line.slice(index, index + 3))?.[0] : undefined;`,
      expected: false,
    },
    {
      label: 'a same-line variable proven to hold a regex keeps its exec method distinct',
      line: String.raw`const pattern = /^(?:f|fr|rf)(?=["'])/i; const match = pattern.exec(line.slice(index, index + 3));`,
      expected: false,
    },
    {
      label: 'reassigning a regex-named runner makes its later exec a shell call',
      line: 'let runner = /x/; runner = child_process; runner.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a property sharing a regex binding name is not that lexical binding',
      line: 'const runner = /x/; const other = { runner: child_process }; other.runner.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a block-local shadow of a regex binding remains a dynamic shell receiver',
      line: 'const runner = /x/; { const runner = child_process; runner.exec("sh -c " + req.query.command); }',
      expected: true,
    },
    {
      label: 'overwriting the regex receiver exec method is still a dynamic shell call',
      line: 'const runner = /x/; runner.exec = child_process.exec; runner.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a parenthesized regex receiver is still a regex exec method',
      line: String.raw`const match = (/^(?:f|fr|rf)(?=["'])/i).exec(line.slice(index, index + 3));`,
      expected: false,
    },
    {
      label: 'command-looking text in a quoted string is not an executed call',
      line: `const example = 'exec("sh " + req.query.command)';`,
      expected: false,
    },
    {
      label: 'command-looking text in a JavaScript comment is not an executed call',
      line: '// exec("sh " + req.query.command)',
      expected: false,
    },
    {
      label: 'a bare exec call concatenating request data remains P0',
      line: 'exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a qualified child_process exec call concatenating request data remains P0',
      line: 'child_process.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a qualified execSync call concatenating a dynamic command remains P0',
      line: 'child_process.execSync("sh -c " + query);',
      expected: true,
    },
    {
      label: 'a bare execSync call concatenating a dynamic command remains P0',
      line: 'execSync("sh -c " + query);',
      expected: true,
    },
    {
      label: 'a qualified spawn call receiving user input remains P0',
      line: 'child_process.spawn("sh", [userInput]);',
      expected: true,
    },
    {
      label: 'a shell command template with unsafe interpolation remains P0',
      line: 'exec(`sh -c ${userInput}`);',
      expected: true,
    },
    {
      label: 'shell variable expansion embedded in a command string remains P0',
      line: 'exec("sh -c ${userInput}");',
      expected: true,
    },
  ])('classifies $label through the preflight entrypoint', async ({ line, expected, filePath }) => {
    const finding = await findCommandInjection(line, filePath || 'src/command.ts');
    if (expected) {
      expect(finding).toMatchObject({ severity: 'P0', category: 'Security' });
    } else {
      expect(finding).toBeUndefined();
    }
  });

  it('scans a deeply nested template without recursive stack growth or a depth cutoff', async () => {
    const line = 'const rendered = ' + '`x${'.repeat(4096) +
      'child_process.exec(req.query.command)' + '}`'.repeat(4096) + ';';
    expect(await findCommandInjection(line)).toMatchObject({ severity: 'P0', category: 'Security' });
  });

  it('does not clip a live substitution after long nonexecuting template text', async () => {
    const line = 'const rendered = `' + 'x'.repeat(96 * 1024) + '${child_process.exec(req.query.command)}`;';
    expect(await findCommandInjection(line)).toMatchObject({ severity: 'P0', category: 'Security' });
  });
});
