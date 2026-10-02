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
      label: 'a built-in RegExp constructor exec matches input rather than running a shell',
      line: 'const match = new RegExp("needle").exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a same-line immutable primitive pattern remains a matcher inside a constructor template',
      line: 'const pattern = "needle"; new RegExp(`${pattern}`).exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a primitive string literal substitution is not a command receiver mutation',
      line: 'new RegExp(`${"needle"}`).exec(req.query.input);',
      expected: false,
    },
    {
      label: 'nested primitive string templates remain intrinsic matcher arguments',
      line: 'new RegExp(`${`${"needle"}`}`).exec(req.query.input);',
      expected: false,
    },
    {
      label: 'primitive numeric and boolean constructor substitutions do not execute commands',
      line: 'new RegExp(`${1}-${true}`).exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a primitive constructor substitution cannot exempt an effectful template tag',
      line: 'const tag = () => { /x/.constructor.prototype.exec = child_process.exec; return "x"; }; new RegExp(tag`${"needle"}`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a primitive constructor substitution cannot exempt an effectful sibling flags argument',
      line: 'const mutate = () => { /x/.constructor.prototype.exec = child_process.exec; return undefined; }; new RegExp(`${"needle"}`, mutate()).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'an opaque constructor template still executes its tag before exec lookup',
      line: 'const tag = () => { /x/.constructor.prototype.exec = child_process.exec; return "x"; }; new RegExp(tag`needle`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a static pattern cannot exempt an effectful constructor flags call',
      line: 'const mutate = () => { /x/.constructor.prototype.exec = child_process.exec; return undefined; }; new RegExp("needle", mutate()).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a sibling flags getter is not primitive constructor evidence',
      line: 'const flags = { get value() { /x/.constructor.prototype.exec = child_process.exec; return undefined; } }; new RegExp(`${"needle"}`, flags.value).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'even an ignored third constructor argument executes before exec lookup',
      line: 'const mutate = () => { /x/.constructor.prototype.exec = child_process.exec; return undefined; }; new RegExp(`${"needle"}`, "g", mutate()).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'constructor spread evaluation cannot borrow primitive template evidence',
      line: 'const patterns = { *[Symbol.iterator]() { /x/.constructor.prototype.exec = child_process.exec; yield "needle"; } }; new RegExp(...patterns).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'closed primitive pattern and flags are both side-effect-free constructor arguments',
      line: 'new RegExp(`${"needle"}`, "g").exec(req.query.input);',
      expected: false,
    },
    {
      label: 'literal pattern and flags preserve the intrinsic matcher exemption',
      line: 'new RegExp("needle", "g").exec(req.query.input);',
      expected: false,
    },
    {
      label: 'an immutable primitive flags binding is proved independently of the pattern template',
      line: 'const flags = "g"; new RegExp(`${"needle"}`, flags).exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a trailing comma adds no effectful sibling constructor argument',
      line: 'new RegExp(`${"needle"}`, "g",).exec(req.query.input);',
      expected: false,
    },
    {
      label: 'an empty intrinsic constructor has no argument evaluation effects',
      line: 'new RegExp().exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a constructor template call cannot establish side-effect-free interpolation',
      line: 'new RegExp(`${changePattern()}`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a constructor template property read cannot establish getter-free interpolation',
      line: 'new RegExp(`${pattern.value}`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a constructor template assignment cannot borrow an earlier primitive binding',
      line: 'let pattern = "needle"; new RegExp(`${(pattern = changePattern())}`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'an earlier primitive binding cannot excuse a prototype mutation in a later substitution',
      line: 'const pattern = "needle"; new RegExp(`${pattern}${(RegExp.prototype.exec = child_process.exec, "x")}`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a TypeScript string annotation is not runtime primitive evidence for a constructor substitution',
      line: 'function find(pattern: string, req: { query: { input: string } }) { return new RegExp(`${pattern}`).exec(req.query.input); }',
      expected: true,
    },
    {
      label: 'an object-backed pattern cannot establish primitive coercion for a constructor template',
      line: 'const pattern = { toString() { RegExp.prototype.exec = child_process.exec; return "x"; } }; new RegExp(`${pattern}`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a mutable primitive declaration is not immutable constructor evidence',
      line: 'let pattern = "needle"; new RegExp(`${pattern}`).exec(req.query.input);',
      expected: true,
    },
    {
      label: 'a block-local pattern cannot borrow a top-level primitive declaration',
      line: 'const pattern = "needle"; { const pattern = injected; new RegExp(`${pattern}`).exec(req.query.input); }',
      expected: true,
    },
    {
      label: 'a preceding executable template cannot hide a mutation before a primitive constructor template',
      line: 'const rendered = `${RegExp.prototype.exec = child_process.exec}`; new RegExp(`${"needle"}`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a preceding opaque template does not revoke a primitive constructor template exemption',
      line: 'const example = `RegExp.prototype.exec = child_process.exec`; new RegExp(`${"needle"}`).exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a safe constructor interpolation never exempts a separate shell call on the same line',
      line: 'new RegExp(`${"needle"}`).exec(req.query.input); child_process.exec(req.query.command);',
      expected: true,
    },
    {
      label: 'a prototype write in a live constructor template argument prevents the regex exemption',
      line: 'new RegExp(`${(RegExp.prototype.exec = child_process.exec, "x")}`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a nested live constructor template cannot hide a prototype write from the receiver fence',
      line: 'new RegExp(`${`${(RegExp.prototype.exec = child_process.exec, "x")}`}`).exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'an escaped constructor substitution is opaque pattern text rather than a prototype write',
      line: 'new RegExp(`\\${(RegExp.prototype.exec = child_process.exec, "x")}`).exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a quoted constructor prototype example is opaque pattern text',
      line: 'new RegExp("RegExp.prototype.exec = child_process.exec").exec(req.query.input);',
      expected: false,
    },
    {
      label: 'an ordinary noninterpolated constructor template keeps the intrinsic matcher exemption',
      line: 'new RegExp(`needle`).exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a previous read-only regex test does not erase regex receiver ownership',
      line: 'const re = /needle/; re.test(input); re.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'direct eval invalidates a regex binding before a later shell exec',
      line: 'let runner = /x/; eval("runner = child_process"); runner.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a regex expression after a closed control block does not hide a shell call',
      line: String.raw`if (enabled) { trace(); } /https?:\/\//.test(url); child_process.exec(req.query.command);`,
      expected: true,
    },
    {
      label: 'an escaped-slash regex after a catch block does not hide a shell call',
      line: String.raw`try {} catch (error) {} /https?:\/\//.test(url); child_process.exec(req.query.command);`,
      expected: true,
    },
    {
      label: 'an escaped-slash regex after a switch block does not hide a shell call',
      line: String.raw`switch (state) { default: break; } /https?:\/\//.test(url); child_process.exec(req.query.command);`,
      expected: true,
    },
    {
      label: 'an escaped-slash regex after an optional-binding catch does not hide a shell call',
      line: String.raw`try {} catch {} /https?:\/\//.test(url); child_process.exec(req.query.command);`,
      expected: true,
    },
    {
      label: 'call-looking regex text after a catch block is not an executed shell call',
      line: 'try {} catch (error) {} /exec(req.query.command)/.test(input);',
      expected: false,
    },
    {
      label: 'call-looking regex text after a switch block is not an executed shell call',
      line: 'switch (state) { default: break; } /exec(req.query.command)/.test(input);',
      expected: false,
    },
    {
      label: 'call-looking regex text after an optional-binding catch remains opaque',
      line: 'try {} catch {} /exec(req.query.command)/.test(input);',
      expected: false,
    },
    {
      label: 'object-literal division is not confused with a closed block regex prefix',
      line: 'const ratio = { value: 10 } / 2; child_process.exec(req.query.command);',
      expected: true,
    },
    {
      label: 'ordinary object-literal division has no command call',
      line: 'const ratio = { catch: 10, switch: 20 } / 2; const next = 1 / 2;',
      expected: false,
    },
    {
      label: 'a catch-named property method does not start a regex after its result',
      line: 'const ratio = obj.catch(error) / 2; child_process.exec(req.query.command); const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'a switch-named property method does not start a regex after its result',
      line: 'const ratio = obj.switch(state) / 2; child_process.exec(req.query.command); const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'a shadowed RegExp constructor does not gain the intrinsic matcher exemption',
      line: 'function search(RegExp) { return new RegExp("needle").exec("sh -c " + req.query.command); }',
      expected: true,
    },
    {
      label: 'a reassigned RegExp constructor does not gain the intrinsic matcher exemption',
      line: 'RegExp = child_process; new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a later hoisted RegExp function declaration cannot borrow the intrinsic matcher exemption',
      line: 'new RegExp("needle").exec("sh -c " + req.query.command); function RegExp() { return { exec: child_process.exec }; }',
      expected: true,
    },
    {
      label: 'a later RegExp declaration still blocks the exemption from a nested array expression',
      line: 'const results = [new RegExp("needle").exec("sh -c " + req.query.command)]; function RegExp() { return { exec: child_process.exec }; }',
      expected: true,
    },
    {
      label: 'an overridden regex instance exec method remains a shell call',
      line: 'const re = /needle/; re.exec = child_process.exec; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a modified RegExp prototype does not gain the literal matcher exemption',
      line: 'RegExp.prototype.exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a regex literal __proto__ exec mutation revokes the literal matcher exemption',
      line: '(/needle/).__proto__.exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a regex literal __proto__ computed exec mutation revokes the literal matcher exemption',
      line: '(/seed/).__proto__["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a regex instance constructor prototype mutation revokes the literal matcher exemption',
      line: '/seed/.constructor.prototype.exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a regex instance constructor prototype computed exec mutation revokes the literal matcher exemption',
      line: '/seed/.constructor.prototype["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Object.getPrototypeOf on another regex instance revokes the constructor matcher exemption',
      line: 'Object.getPrototypeOf(/seed/).exec = child_process.exec; new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Object.getPrototypeOf computed exec mutation revokes the literal matcher exemption',
      line: 'Object.getPrototypeOf(/seed/)["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Reflect.getPrototypeOf on another regex instance revokes the literal matcher exemption',
      line: 'Reflect.getPrototypeOf(/seed/).exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Reflect.getPrototypeOf computed exec mutation revokes the literal matcher exemption',
      line: 'Reflect.getPrototypeOf(/seed/)["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'an aliased instance prototype exec mutation revokes the constructor matcher exemption',
      line: 'const p = (/seed/).__proto__; p.exec = child_process.exec; new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'mutating one regex binding prototype revokes another regex binding exemption',
      line: 'const seed = /seed/; seed.__proto__.exec = child_process.exec; const re = /needle/; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'an aliased computed exec property mutation revokes the literal matcher exemption',
      line: 'const p = Object.getPrototypeOf(/seed/); p["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped __proto__ dot assignment revokes the literal matcher exemption',
      line: '((/seed/).__proto__).exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a computed __proto__ escape mutation revokes the literal matcher exemption',
      line: '(/seed/)["__proto__"].exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a computed constructor prototype escape mutation revokes the literal matcher exemption',
      line: '/seed/.constructor["prototype"].exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a computed Object getPrototypeOf escape mutation revokes the literal matcher exemption',
      line: 'Object["getPrototypeOf"](/seed/).exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a computed Reflect getPrototypeOf escape mutation revokes the literal matcher exemption',
      line: 'Reflect["getPrototypeOf"](/seed/).exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a multiply grouped __proto__ computed assignment revokes the constructor matcher exemption',
      line: '(((/seed/).__proto__))["exec"] = child_process.exec; new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped constructor prototype dot assignment revokes the constructor matcher exemption',
      line: '(/seed/.constructor.prototype).exec = child_process.exec; new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a multiply grouped constructor prototype computed assignment revokes a regex binding exemption',
      line: '((/seed/.constructor.prototype))["exec"] = child_process.exec; const re = /needle/; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped Object prototype dot assignment revokes the literal matcher exemption',
      line: '(Object.getPrototypeOf(/seed/)).exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a multiply grouped Object prototype computed assignment revokes the constructor matcher exemption',
      line: '((Object.getPrototypeOf(/seed/)))["exec"] = child_process.exec; new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped Reflect prototype dot assignment revokes a regex binding exemption',
      line: '(Reflect.getPrototypeOf(/seed/)).exec = child_process.exec; const re = /needle/; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a multiply grouped Reflect prototype computed assignment revokes the literal matcher exemption',
      line: '((Reflect.getPrototypeOf(/seed/)))["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped __proto__ alias dot assignment revokes the literal matcher exemption',
      line: 'const p = (/seed/).__proto__; (p).exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a multiply grouped __proto__ alias computed assignment revokes a regex binding exemption',
      line: 'const p = (((/seed/).__proto__)); ((p))["exec"] = child_process.exec; const re = /needle/; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped constructor prototype alias dot assignment revokes the constructor matcher exemption',
      line: 'const p = (/seed/.constructor.prototype); (p).exec = child_process.exec; new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a multiply grouped constructor prototype alias computed assignment revokes the literal matcher exemption',
      line: 'const p = ((/seed/.constructor.prototype)); ((p))["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped Object prototype alias dot assignment revokes a regex binding exemption',
      line: 'const p = (Object.getPrototypeOf(/seed/)); (p).exec = child_process.exec; const re = /needle/; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a multiply grouped Object prototype alias computed assignment revokes the literal matcher exemption',
      line: 'const p = ((Object.getPrototypeOf(/seed/))); ((p))["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped Reflect prototype alias dot assignment revokes the literal matcher exemption',
      line: 'const p = (Reflect.getPrototypeOf(/seed/)); (p).exec = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a multiply grouped Reflect prototype alias computed assignment revokes the constructor matcher exemption',
      line: 'const p = ((Reflect.getPrototypeOf(/seed/))); ((p))["exec"] = child_process.exec; new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'quoted grouped prototype mutation text does not revoke an intrinsic literal exemption',
      line: 'const example = "((/seed/).__proto__).exec = child_process.exec"; /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'commented grouped prototype mutation text does not revoke a regex binding exemption',
      line: '/* ((Reflect.getPrototypeOf(/seed/)))["exec"] = child_process.exec */ const re = /needle/; re.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'opaque template grouped prototype mutation text does not revoke a constructor exemption',
      line: 'const example = `const p = Object.getPrototypeOf(/seed/); ((p))["exec"] = child_process.exec`; new RegExp("needle").exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a computed RegExp prototype exec write revokes the literal matcher exemption',
      line: 'RegExp["prototype"].exec = child_process.exec; /needle/.exec("sh -c "+req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped RegExp owner prototype write revokes a regex binding exemption',
      line: '(RegExp).prototype.exec = child_process.exec; const re = /needle/; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a grouped computed RegExp prototype computed write revokes the literal matcher exemption',
      line: '(((RegExp)["prototype"]))["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a computed RegExp prototype alias grouped write revokes the literal matcher exemption',
      line: 'const p = ((RegExp)["prototype"]); ((p))["exec"] = child_process.exec; /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Object.assign on an explicit instance prototype revokes the literal matcher exemption',
      line: 'Object.assign((/seed/).__proto__, {exec:child_process.exec}); /needle/.exec("sh -c "+req.query.command);',
      expected: true,
    },
    {
      label: 'computed Object.assign on a grouped computed prototype alias revokes the constructor exemption',
      line: 'const p = Object["getPrototypeOf"](/seed/); Object["assign"]((p), { exec: child_process.exec }); new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Object.defineProperty on a grouped computed constructor prototype revokes a regex binding exemption',
      line: 'Object.defineProperty((/seed/.constructor["prototype"]), "exec", { value: child_process.exec }); const re = /needle/; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'computed Object.defineProperty on a grouped instance prototype alias revokes the literal exemption',
      line: 'const p = (/seed/)["__proto__"]; Object["defineProperty"](((p)), "exec", { value: child_process.exec }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Object.defineProperties on a grouped Object prototype revokes the constructor matcher exemption',
      line: 'Object.defineProperties((Object.getPrototypeOf(/seed/)), { exec: { value: child_process.exec } }); new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'computed Object.defineProperties on a grouped Reflect prototype alias revokes the literal exemption',
      line: 'const p = Reflect.getPrototypeOf(/seed/); Object["defineProperties"](((p)), { exec: { value: child_process.exec } }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Reflect.set on a grouped Reflect prototype revokes a regex binding exemption',
      line: 'Reflect.set((Reflect.getPrototypeOf(/seed/)), "exec", child_process.exec); const re = /needle/; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'computed Reflect.set on a grouped computed constructor prototype alias revokes the literal exemption',
      line: 'const p = /seed/.constructor["prototype"]; Reflect["set"]((p), "exec", child_process.exec); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Reflect.defineProperty on a grouped computed Object prototype revokes the constructor exemption',
      line: 'Reflect.defineProperty(((Object["getPrototypeOf"](/seed/))), "exec", { value: child_process.exec }); new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'computed Reflect.defineProperty on a grouped RegExp prototype alias revokes the literal exemption',
      line: 'const p = (RegExp)["prototype"]; Reflect["defineProperty"](((p)), "exec", { value: child_process.exec }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Object.assign on an unrelated plain object leaves a literal matcher intrinsic',
      line: 'Object.assign({}, { exec: child_process.exec }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'Object.assign does not treat its prototype source argument as its mutation target',
      line: 'Object["assign"]({}, (/seed/).__proto__); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'Object.defineProperty does not treat a descriptor prototype reference as its target',
      line: 'Object.defineProperty({}, "exec", { value: child_process.exec, saved: Object.getPrototypeOf(/seed/) }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'Object.defineProperties on an object containing a prototype reference leaves a literal matcher intrinsic',
      line: 'Object["defineProperties"]({ saved: Object.getPrototypeOf(/seed/) }, { exec: { value: child_process.exec } }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'Reflect.set on an unrelated grouped plain object leaves a literal matcher intrinsic',
      line: 'Reflect["set"](({}), "exec", child_process.exec); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'Reflect.defineProperty on an unrelated plain object leaves a regex binding intrinsic',
      line: 'Reflect.defineProperty({}, "exec", { value: child_process.exec }); const re = /needle/; re.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'quoted Object.assign prototype mutation text leaves a literal matcher intrinsic',
      line: 'const example = "Object.assign((/seed/).__proto__, {exec:child_process.exec})"; /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'commented Reflect.set prototype mutation text leaves a regex binding intrinsic',
      line: '/* Reflect.set(Reflect.getPrototypeOf(/seed/), "exec", child_process.exec) */ const re = /needle/; re.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'opaque template defineProperty prototype mutation text leaves a constructor intrinsic',
      line: 'const example = `Object["defineProperty"]((/seed/).__proto__, "exec", {value:child_process.exec})`; new RegExp("needle").exec(req.query.input);',
      expected: false,
    },
    {
      label: 'pure computed Object prototype inspection leaves a literal matcher intrinsic',
      line: 'const p = Object["getPrototypeOf"](/seed/); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'pure grouped Reflect prototype inspection leaves a regex binding intrinsic',
      line: 'const p = (Reflect.getPrototypeOf(/seed/)); const re = /needle/; re.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'pure grouped computed RegExp prototype inspection leaves a literal matcher intrinsic',
      line: 'const p = (RegExp)["prototype"]; /needle/.exec(req.query.input);',
      expected: false,
    },
    ...[
      { owner: 'Object', method: 'assign', mutationArguments: '{exec:child_process.exec}' },
      { owner: 'Object', method: 'defineProperty', mutationArguments: '"exec", { value: child_process.exec }' },
      { owner: 'Object', method: 'defineProperties', mutationArguments: '{ exec: { value: child_process.exec } }' },
      { owner: 'Reflect', method: 'set', mutationArguments: '"exec", child_process.exec' },
      { owner: 'Reflect', method: 'defineProperty', mutationArguments: '"exec", { value: child_process.exec }' },
    ].flatMap(({ owner, method, mutationArguments }) => [
      {
        label: `optional property ${owner}.${method} on an explicit prototype revokes the literal exemption`,
        line: `${owner}?.${method}((/seed/).__proto__,${mutationArguments}); /needle/.exec("sh -c "+req.query.command);`,
        expected: true,
      },
      {
        label: `optional call ${owner}.${method} on an explicit prototype revokes the literal exemption`,
        line: `${owner}.${method}?.((/seed/).__proto__,${mutationArguments}); /needle/.exec("sh -c "+req.query.command);`,
        expected: true,
      },
      {
        label: `combined optional computed ${owner}.${method} on a grouped alias revokes a regex binding exemption`,
        line: `const p = (/seed/).__proto__; ${owner}?.["${method}"]?.(((p)),${mutationArguments}); const re = /needle/; re.exec("sh -c "+req.query.command);`,
        expected: true,
      },
      {
        label: `combined optional computed ${owner}.${method} on a plain object leaves the literal exemption intact`,
        line: `${owner}?.["${method}"]?.(({}),${mutationArguments}); /needle/.exec(req.query.input);`,
        expected: false,
      },
    ]),
    {
      label: 'Object.assign on an optional Object prototype inspection revokes the literal exemption',
      line: 'Object.assign(Object.getPrototypeOf?.(/seed/), { exec: child_process.exec }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Reflect.set on combined optional computed Reflect prototype inspection revokes the constructor exemption',
      line: 'Reflect.set(Reflect?.["getPrototypeOf"]?.(/seed/), "exec", child_process.exec); new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'Object.assign on a grouped Object prototype inspection callee revokes the literal exemption',
      line: 'Object.assign((Object.getPrototypeOf)(/seed/), { exec: child_process.exec }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'an optional grouped Object.assign callee revokes the literal exemption',
      line: '(Object.assign)?.((/seed/).__proto__, { exec: child_process.exec }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'optional grouped computed Reflect mutation and inspection callees revoke a regex binding exemption',
      line: '(Reflect["defineProperty"])?.((Reflect["getPrototypeOf"])?.(/seed/), "exec", { value: child_process.exec }); const re = /needle/; re.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'an optional grouped prototype inspection alias remains an explicit Reflect.set target',
      line: 'const p = (Object.getPrototypeOf)?.(/seed/); Reflect.set((p), "exec", child_process.exec); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'combined optional computed grouped Object mutation and inspection callees revoke the constructor exemption',
      line: '(Object?.["assign"])?.(((Object?.["getPrototypeOf"])?.(/seed/)), { exec: child_process.exec }); new RegExp("needle").exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'an optional Object.assign source prototype is not its plain-object mutation target',
      line: 'Object?.["assign"]?.({}, (Object.getPrototypeOf)?.(/seed/)); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'quoted optional Object.assign prototype mutation text leaves the literal exemption intact',
      line: 'const example = "Object?.assign((/seed/).__proto__,{exec:child_process.exec})"; /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'commented optional Reflect.set prototype mutation text leaves a regex binding exemption intact',
      line: '/* Reflect["set"]?.((/seed/).__proto__, "exec", child_process.exec) */ const re = /needle/; re.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'opaque template combined optional defineProperty mutation text leaves the constructor exemption intact',
      line: 'const example = `Object?.["defineProperty"]?.((/seed/).__proto__, "exec", {value:child_process.exec})`; new RegExp("needle").exec(req.query.input);',
      expected: false,
    },
    {
      label: 'pure optional grouped Object prototype inspection leaves the literal exemption intact',
      line: 'const p = (Object?.["getPrototypeOf"])?.(/seed/); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'pure optional Reflect prototype inspection leaves a regex binding exemption intact',
      line: 'const p = Reflect?.getPrototypeOf?.(/seed/); const re = /needle/; re.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'an object holding a prototype is not itself a prototype alias for Object.assign',
      line: 'const box = { saved: Object.getPrototypeOf(/seed/) }; Object.assign(box, { exec: child_process.exec }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a grouped object holding a prototype is not itself a prototype alias for defineProperty',
      line: 'const box = (({ saved: Reflect.getPrototypeOf(/seed/) })); Object.defineProperty((box), "exec", { value: child_process.exec }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a nested container prototype reference does not make an exec write a prototype mutation',
      line: 'const box = { saved: { prototype: Object.getPrototypeOf(/seed/) } }; (box).exec = child_process.exec; /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'an array holding a prototype is not itself a prototype alias for Reflect.set',
      line: 'const box = [Object.getPrototypeOf(/seed/)]; Reflect.set(box, "exec", child_process.exec); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'an array containing a prototype member name is not itself a prototype alias',
      line: 'const box = ["__proto__"]; Object.assign(box, { exec: child_process.exec }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'an arrow returning a prototype is not itself a prototype alias for Object.assign',
      line: 'const fn = () => Object.getPrototypeOf(/seed/); Object.assign(fn, { exec: child_process.exec }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a grouped arrow returning a prototype is not itself a prototype alias for Reflect.defineProperty',
      line: 'const fn = ((() => Reflect?.["getPrototypeOf"]?.(/seed/))); Reflect.defineProperty(fn, "exec", { value: child_process.exec }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a function returning a prototype is not itself a prototype alias for defineProperties',
      line: 'const fn = function () { return Object.getPrototypeOf(/seed/); }; Object.defineProperties(fn, { exec: { value: child_process.exec } }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a direct arrow target returning a prototype is still a function object',
      line: 'Object.assign(() => Object.getPrototypeOf(/seed/), { exec: child_process.exec }); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a grouped direct arrow target returning a prototype is still a function object',
      line: 'Reflect["set"]?.((() => (Object.getPrototypeOf)(/seed/)), "exec", child_process.exec); /needle/.exec(req.query.input);',
      expected: false,
    },
    {
      label: 'a whole grouped instance prototype initializer remains an unsafe mutation alias',
      line: 'const p = (((/seed/).__proto__)); Object.assign((p), { exec: child_process.exec }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a whole optional grouped inspection initializer remains an unsafe mutation alias',
      line: 'const p = (((Object?.["getPrototypeOf"])?.(/seed/))); Reflect.set((p), "exec", child_process.exec); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a whole grouped constructor prototype initializer remains an unsafe mutation alias',
      line: 'const p = ((/seed/.constructor["prototype"])); Object["defineProperties"]?.((p), { exec: { value: child_process.exec } }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a whole grouped RegExp prototype initializer remains an unsafe mutation alias',
      line: 'const p = (((RegExp)["prototype"])); Reflect["defineProperty"]?.((p), "exec", { value: child_process.exec }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a whole member receiver prototype initializer remains an unsafe mutation alias',
      line: 'const holder = { re: /seed/ }; const p = holder.re.__proto__; Object.assign(p, { exec: child_process.exec }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a whole inspection receiver constructor prototype initializer remains an unsafe mutation alias',
      line: 'const p = Object.getPrototypeOf(/seed/).constructor.prototype; Reflect.set(p, "exec", child_process.exec); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'a complete first-declarator prototype initializer remains an unsafe mutation alias',
      line: 'const p = Object.getPrototypeOf(/seed/), note = "unchanged"; Object.assign(p, { exec: child_process.exec }); /needle/.exec("sh -c " + req.query.command);',
      expected: true,
    },
    {
      label: 'eval during RegExp construction blocks the intrinsic matcher exemption',
      line: 'const match = new RegExp(eval("RegExp.prototype.exec = child_process.exec")).exec("sh -c " + req.query.command);',
      expected: true,
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
  ].map(control => [control.label, control] as const))('classifies %s through the preflight entrypoint', async (_label, { line, expected, filePath }) => {
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

  it('proves deeply nested primitive constructor templates without a recursive exemption walk', async () => {
    const line = 'new RegExp(' + '`x${'.repeat(4096) + '"needle"' +
      '}`'.repeat(4096) + ').exec(req.query.input);';
    expect(await findCommandInjection(line)).toBeUndefined();
  });

  it('does not clip a live substitution after long nonexecuting template text', async () => {
    const line = 'const rendered = `' + 'x'.repeat(96 * 1024) + '${child_process.exec(req.query.command)}`;';
    expect(await findCommandInjection(line)).toMatchObject({ severity: 'P0', category: 'Security' });
  });
});
