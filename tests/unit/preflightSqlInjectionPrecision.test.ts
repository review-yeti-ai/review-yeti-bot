import { describe, expect, it } from 'vitest';
import { createPreflightDiffReviewTool } from '../../src/mcp/server/tools/preflightDiffReview';

async function findStaticSqlInjection(addedLine: string): Promise<{ severity: string; category: string } | undefined> {
  const result = await createPreflightDiffReviewTool().execute({
    repo: 'example/repository',
    diff: `diff --git a/src/query.ts b/src/query.ts
--- a/src/query.ts
+++ b/src/query.ts
@@ -1,0 +1,1 @@
+${addedLine}
`,
  });
  const textContent = result.content.find((content) => content.type === 'text');
  if (!textContent || textContent.type !== 'text') throw new Error('Preflight returned no text result');
  const payload = JSON.parse(textContent.text);
  return payload.findings.find((finding: { finding_id: string }) =>
    finding.finding_id.startsWith('pref-sqli-')
  );
}

describe('preflight SQL injection static screening precision', () => {
  it.each([
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
      label: 'a raw SQL line comment containing request-like text',
      line: 'SELECT * FROM users -- + req.query.id',
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
      label: 'a Python f-string whose doubled braces are literal SQL text',
      line: 'query = f"SELECT * FROM events WHERE payload = \'{{literal}}\'"',
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
      label: 'a request value interpolated into a Python f-string',
      line: 'query = f"SELECT * FROM users WHERE id = {request.args[\'id\']}"',
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
});
