import { describe, expect, it } from 'vitest';
import { createPreflightDiffReviewTool } from '../../src/mcp/server/tools/preflightDiffReview';

async function findStaticSqlInjection(
  addedLine: string,
  filePath = 'src/query.ts',
): Promise<{ severity: string; category: string } | undefined> {
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
    finding.finding_id.startsWith('pref-sqli-')
  );
  if (finding) expect(payload.eligible_to_ship).toBe(false);
  return finding;
}

describe('preflight SQL injection static screening precision', () => {
  it.each([
    {
      label: 'keyword property division cannot swallow later unsafe SQL',
      line: 'const ratio = obj.return / 2; const query = "SELECT * FROM users WHERE id = " + req.id; const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'keyword method division cannot swallow later unsafe SQL',
      line: 'const ratio = obj.if(enabled) / 2; const query = "SELECT * FROM users WHERE id = " + req.id; const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'postfix increment division cannot swallow later unsafe SQL',
      line: 'const ratio = count++ / 2; const query = "SELECT * FROM users WHERE id = " + req.id; const next = 1 / 2;',
      expected: true,
    },
    {
      label: 'a real return-statement regex does not hide later unsafe SQL',
      line: String.raw`function pattern() { return /https?:\/\//; } const query = "SELECT * FROM users WHERE id = " + req.id;`,
      expected: true,
    },
    {
      label: 'dynamic SQL executed in a template expression remains visible',
      line: 'const rendered = `${db.query("SELECT * FROM users WHERE id = " + req.id)}`;',
      expected: true,
    },
    {
      label: 'a parameterized query inside a template expression keeps its values separate',
      line: 'const rendered = `${db.query("SELECT * FROM users WHERE id = $1", [req.id + 1])}`;',
      expected: false,
    },
    {
      label: 'a nonexecuting SQL example in template text remains static',
      line: 'const example = `db.query("SELECT * FROM users WHERE id = " + req.id)`;',
      expected: false,
    },
    {
      label: 'a bound deadline SQL expression with arithmetic inside its literal',
      line: 'const deadlineSql = "SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.03) FROM review_runs WHERE run_id = $2";',
      expected: false,
    },
    {
      label: 'ordinary SQL arithmetic inside its literal',
      line: 'const query = "SELECT amount FROM invoices WHERE amount = 1 + 2";',
      expected: false,
    },
    {
      label: 'the SQL CONCAT function and a quoted plus inside its literal',
      line: 'const query = "SELECT * FROM users WHERE CONCAT(first_name, \'x+y\') = $1";',
      expected: false,
    },
    {
      label: 'SQL comments containing plus and request-like text inside its literal',
      line: 'const query = "SELECT * FROM users WHERE id = $1 -- + req.query.id";',
      expected: false,
    },
    {
      label: 'a JavaScript decrement does not hide later unsafe query construction',
      line: 'let version = current--; const query = "SELECT * FROM users WHERE id = " + req.id;',
      expected: true,
    },
    {
      label: 'a static query split across host-language string fragments',
      line: 'const query = "SELECT * " + "FROM users";',
      expected: false,
    },
    {
      label: 'an unrelated host-language addition in a later statement',
      line: 'const query = "SELECT * FROM users"; const label = left + right;',
      expected: false,
    },
    {
      label: 'a parameterized query whose request value is passed separately',
      line: 'db.query("SELECT * FROM users WHERE id = $1", [req.query.id]);',
      expected: false,
    },
    {
      label: 'host-language concatenation after a static SQL fragment',
      line: 'const query = "SELECT * FROM users WHERE " + "id = " + params.id;',
      expected: true,
    },
    {
      label: 'host-language concatenation with a non-request dynamic identifier',
      line: 'const query = "SELECT * FROM users WHERE tenant = " + tenantFilter;',
      expected: true,
    },
    {
      label: 'an unsafe value between SQL fragments split across string literals',
      line: 'const query = "SELECT * " + tenantFilter + " FROM tenants";',
      expected: true,
    },
    {
      label: 'a request value interpolated into a SQL template literal',
      line: 'const query = `SELECT * FROM users WHERE id = ${req.body.id}`;',
      expected: true,
    },
    {
      label: 'a host concat call that receives SQL and a request value',
      line: 'const query = concat("SELECT * FROM users WHERE id = ", req.query.id);',
      expected: true,
    },
    {
      label: 'an unsafe second concatenand even when another placeholder is bound',
      line: 'const query = "SELECT * FROM users WHERE id = $1 AND status = " + req.body.status;',
      expected: true,
    },
  ])('classifies $label without confusing SQL text with host code', async ({ line, expected }) => {
    const finding = await findStaticSqlInjection(line);
    if (expected) {
      expect(finding).toMatchObject({ severity: 'P0', category: 'Security' });
    } else {
      expect(finding).toBeUndefined();
    }
  });

  it.each([
    {
      label: 'SQL CONCAT over columns is a database function, not host construction',
      filePath: 'queries/user-search.sql',
      line: "SELECT * FROM users WHERE CONCAT(first_name, last_name) = 'Ada';",
      expected: false,
    },
    {
      label: 'SQL arithmetic over columns is a database expression',
      filePath: 'queries/invoice-total.sql',
      line: 'SELECT amount + tax FROM invoices WHERE total = amount + tax;',
      expected: false,
    },
    {
      label: 'a raw SQL line comment ignores request-like text',
      filePath: 'queries/user-search.sql',
      line: 'SELECT * FROM users -- + req.query.id',
      expected: false,
    },
    {
      label: 'JavaScript double-quoted SQL does not interpolate dollar names',
      filePath: 'src/query.ts',
      line: `const query = "SELECT * FROM users WHERE tenant = '$tenant'";`,
      expected: false,
    },
    {
      label: 'JavaScript double-quoted SQL does not interpolate hash braces',
      filePath: 'src/query.ts',
      line: `const query = "SELECT * FROM users WHERE note = '#{literal}'";`,
      expected: false,
    },
    {
      label: 'SQL dynamic execution still flags a concatenated identifier',
      filePath: 'queries/user-search.sql',
      line: "EXEC('SELECT * FROM users WHERE id = ' + @userId);",
      expected: true,
    },
    {
      label: 'arithmetic in a separate bound-parameter argument is not SQL construction',
      filePath: 'src/query.ts',
      line: 'db.query("SELECT * FROM users WHERE id = $1", [req.query.id + 1]);',
      expected: false,
    },
    {
      label: 'JavaScript identifiers and decrement do not create SQL comment state',
      filePath: 'src/query.ts',
      line: 'const select = from; version--; const query = "SELECT * FROM users WHERE id = " + req.id;',
      expected: true,
    },
    {
      label: 'a JavaScript private member does not hide unsafe SQL later on the line',
      filePath: 'src/query.ts',
      line: 'class Counter { #hits = 0; run(req: any) { this.#hits++; const query = "SELECT * FROM users WHERE id = " + req.id; return query; } }',
      expected: true,
    },
    {
      label: 'dynamic template text in a bound-value array is not query construction',
      filePath: 'src/query.ts',
      line: 'db.query("SELECT * FROM users WHERE id = $1", [`${req.query.id}`]);',
      expected: false,
    },
    {
      label: 'concat in a bound-value array is not query construction',
      filePath: 'src/query.ts',
      line: `db.query("SELECT * FROM users WHERE external_key = $1", ['id:'.concat(req.query.id)]);`,
      expected: false,
    },
    {
      label: 'a SQL-bearing string used as a concat method receiver is query construction',
      filePath: 'src/query.ts',
      line: 'const query = "SELECT * FROM users WHERE id = ".concat(req.id);',
      expected: true,
    },
    {
      label: 'a parenthesized SQL literal remains the concat method receiver',
      filePath: 'src/query.ts',
      line: 'const query = ("SELECT * FROM users WHERE id = ").concat(req.id);',
      expected: true,
    },
    {
      label: 'a chained concat receiver retains its SQL-bearing origin',
      filePath: 'src/query.ts',
      line: 'const query = "SELECT * FROM users WHERE id = ".concat(prefix).concat(req.id);',
      expected: true,
    },
    {
      label: 'chained concat inside a bound-value array remains separate from SQL text',
      filePath: 'src/query.ts',
      line: 'db.query("SELECT * FROM users WHERE external_key = $1", ["id:".concat(prefix).concat(req.id)]);',
      expected: false,
    },
    {
      label: 'an escaped-slash regex before unsafe SQL does not become a line comment',
      filePath: 'src/query.ts',
      line: String.raw`const pattern = /https?:\/\//; const query = "SELECT * FROM users WHERE id = " + req.id;`,
      expected: true,
    },
    {
      label: 'regex character classes and escaped delimiters preserve later SQL analysis',
      filePath: 'src/query.ts',
      line: String.raw`const pattern = /[a-z\/]+https?:\/\//; const query = "SELECT * FROM users WHERE id = " + req.id;`,
      expected: true,
    },
    {
      label: 'ordinary division remains an operator rather than a regex literal',
      filePath: 'src/query.ts',
      line: 'const ratio = numerator / denominator; const query = "SELECT * FROM users WHERE id = " + req.id;',
      expected: true,
    },
    {
      label: 'a regex expression after a control condition does not hide later SQL',
      filePath: 'src/query.ts',
      line: String.raw`if (enabled) /https?:\/\//.test(url); const query = "SELECT * FROM users WHERE id = " + req.id;`,
      expected: true,
    },
    {
      label: 'Python f-string interpolation follows Python source syntax',
      filePath: 'src/query.py',
      line: `query = f"SELECT * FROM users WHERE id = {request.args['id']}"`,
      expected: true,
    },
    {
      label: 'escaped Python f-string braces remain literal SQL text',
      filePath: 'src/query.py',
      line: `query = f"SELECT * FROM events WHERE payload = '{{literal}}'"`,
      expected: false,
    },
    {
      label: 'a real Python comment cannot create an injection finding',
      filePath: 'src/query.py',
      line: `# query = f"SELECT * FROM users WHERE id = {request.args['id']}"`,
      expected: false,
    },
    {
      label: 'a real Ruby comment cannot create an injection finding',
      filePath: 'src/query.rb',
      line: `# query = "SELECT * FROM users WHERE id = #{params[:id]}"`,
      expected: false,
    },
    {
      label: 'Ruby double-quoted interpolation follows Ruby source syntax',
      filePath: 'src/query.rb',
      line: `query = "SELECT * FROM users WHERE id = #{params[:id]}"`,
      expected: true,
    },
    {
      label: 'Elixir double-quoted interpolation follows Elixir source syntax',
      filePath: 'lib/query.ex',
      line: `query = "SELECT * FROM users WHERE id = #{params.id}"`,
      expected: true,
    },
  ])('respects $label at the actual source path', async ({ filePath, line, expected }) => {
    const finding = await findStaticSqlInjection(line, filePath);
    if (expected) {
      expect(finding).toMatchObject({ severity: 'P0', category: 'Security' });
    } else {
      expect(finding).toBeUndefined();
    }
  });

  it('retains the dynamic tail in a long static SQL fragment chain', async () => {
    const fragments = ['"SELECT * "', ...Array.from({ length: 96 }, () => '"column"'), '" FROM users WHERE id = "'];
    const line = `const query = ${fragments.join(' + ')} + req.id;`;
    const finding = await findStaticSqlInjection(line);
    expect(finding).toMatchObject({ severity: 'P0', category: 'Security' });
  });
});
