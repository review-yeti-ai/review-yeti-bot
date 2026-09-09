import { describe, it, expect } from 'vitest';
import { containsExecutableOrSensitiveCode } from '../../src/panel/classifierEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema, ctReviewConfigV4Schema } from '../../src/config/schema';

describe('Milestone 1 Challenger Stress Suite (R1 & R2)', () => {
  describe('1. File Size Limits Stress Tests', () => {
    it('permits documentation files exactly at 1MB threshold (1,048,576 bytes)', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', size: 1_048_576 }])).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', byteSize: 1_048_576 }])).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', content: 'a'.repeat(1_048_576) }])).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', patch: 'a'.repeat(1_048_576) }])).toBe(false);
    });

    it('strictly bars files at 1MB + 1 byte (1,048,577 bytes)', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', size: 1_048_577 }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', byteSize: 1_048_577 }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', content: 'a'.repeat(1_048_577) }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', patch: 'a'.repeat(1_048_577) }])).toBe(true);
    });

    it('correctly calculates byte size for UTF-8 multibyte characters (> 1MB byte count with < 1MB character count)', () => {
      const emojiString = '😀'.repeat(300_000); // 300k chars * 4 bytes = 1.2MB
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', content: emojiString }])).toBe(true);
    });

    it('respects custom maxFileSize options (e.g. 500,000 bytes)', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', size: 400_000 }], { maxFileSize: 500_000 })).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.md', size: 500_001 }], { maxFileSize: 500_000 })).toBe(true);
    });

    it('PROVES VULNERABILITY: negative file size bypasses size checks on 2MB content', () => {
      // Because typeof file.size === 'number' matches -1, byteSize becomes -1, and -1 > maxFileSize is false.
      // Content of 2MB is completely ignored!
      const result = containsExecutableOrSensitiveCode([{
        path: 'docs/evil.md',
        size: -1,
        content: 'a'.repeat(2_000_000),
      }]);
      // A secure implementation rejects or inspects content.
      expect(result).toBe(true);
    });

    it('PROVES VULNERABILITY: NaN file size bypasses size checks on 2MB content', () => {
      // typeof NaN === 'number', but NaN > maxFileSize is false.
      const result = containsExecutableOrSensitiveCode([{
        path: 'docs/evil.md',
        size: NaN,
        content: 'a'.repeat(2_000_000),
      }]);
      expect(result).toBe(true);
    });
  });

  describe('2. YAML Schema File Size Validation', () => {
    const validBaseConfig = {
      version: 3,
      profile: 'balanced',
      quorum: 1,
      personas: [{ id: 'sec', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] }],
      reviewers: {
        execution: 'personas',
        fallback: 'none',
        overall_timeout_s: 30,
        providers: [{ id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'low', review_timeout_s: 15, arbiter_timeout_s: 15 }],
        arbiter: { order: ['claude'] },
      },
    };

    it('validates positive integers for max_file_size and max_file_bytes in v3 and v4', () => {
      const v3 = ctReviewConfigV3Schema.parse({ ...validBaseConfig, max_file_size: 500_000, max_file_bytes: 500_000 });
      expect(v3.max_file_size).toBe(500_000);
      expect(v3.max_file_bytes).toBe(500_000);
    });

    it('rejects negative numbers, zero, floats, and strings in max_file_size YAML', () => {
      expect(() => parseAndValidateConfig(`
version: 3
quorum: 1
max_file_size: -1
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ['**']
    providers: ['claude']
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: claude
      enabled: true
      model: claude-5-sonnet
      effort: low
      review_timeout_s: 15
      arbiter_timeout_s: 15
  arbiter:
    order: ['claude']
`)).toThrow(/max_file_size: Number must be greater than 0/);

      expect(() => parseAndValidateConfig(`
version: 3
quorum: 1
max_file_size: 0
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ['**']
    providers: ['claude']
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: claude
      enabled: true
      model: claude-5-sonnet
      effort: low
      review_timeout_s: 15
      arbiter_timeout_s: 15
  arbiter:
    order: ['claude']
`)).toThrow(/max_file_size: Number must be greater than 0/);

      expect(() => parseAndValidateConfig(`
version: 3
quorum: 1
max_file_size: "1MB"
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ['**']
    providers: ['claude']
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: claude
      enabled: true
      model: claude-5-sonnet
      effort: low
      review_timeout_s: 15
      arbiter_timeout_s: 15
  arbiter:
    order: ['claude']
`)).toThrow(/max_file_size: Expected number, received string/);
    });
  });

  describe('3. File Allowlist & Tricky Filenames Stress Tests', () => {
    it('strictly blocks case variations and nested paths of build/dependency files', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'REQUIREMENTS.TXT' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'sub/requirements.txt' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'sub/REQUIREMENTS.TXT' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'cmakeLists.txt' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'sub/cmakeLists.txt' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'sub/CMakeLists.txt' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'requirements-dev.txt' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'requirements_prod.txt' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'constraints.txt' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'Gemfile' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'sub/Gemfile' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'Gemfile.lock' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'Makefile' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'Rakefile' }])).toBe(true);
    });

    it('blocks .adoc and .rst with include:: and raw:: in content or patch', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.adoc', content: 'include::secret.adoc[]' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.adoc', patch: '+ include::secret.adoc[]' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.rst', content: '.. raw:: html\n<script>' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.rst', patch: '+ .. raw:: html\n<script>' }])).toBe(true);
    });

    it('permits clean .adoc and .rst files without directives', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.adoc', content: '= Clean Title\nText' }])).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/guide.rst', content: 'Clean Title\n===========\nText' }])).toBe(false);
    });

    it('PROVES VULNERABILITY: include::foo.adoc and raw::html.rst in file path bypass directive inspection', () => {
      const adocResult = containsExecutableOrSensitiveCode([{ path: 'include::foo.adoc' }]);
      const rstResult = containsExecutableOrSensitiveCode([{ path: 'raw::html.rst' }]);
      expect(adocResult).toBe(true);
      expect(rstResult).toBe(true);
    });

    it('allows harmless .txt basenames and avoids false positives on security.txt', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'robots.txt' }])).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: 'humans.txt' }])).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: 'license.txt' }])).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: 'notice.txt' }])).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: 'security.txt' }])).toBe(false);
      expect(containsExecutableOrSensitiveCode([{ path: '.well-known/security.txt' }])).toBe(false);
    });

    it('bars non-allowlisted .txt files', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'notes.txt' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'readme.txt' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'sub/data.txt' }])).toBe(true);
    });
  });

  describe('4. Symlinks & Executable Mode Bits Stress Tests', () => {
    it('blocks string mode 120000 and new file mode 120000 patches', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/link.md', mode: '120000' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/link.md', patch: 'new file mode 120000\n+ target' }])).toBe(true);
    });

    it('PROVES VULNERABILITY: numeric mode 120000 bypasses symlink check', () => {
      // file.mode === '120000' or 120000 now both correctly rejected
      const result = containsExecutableOrSensitiveCode([{ path: 'docs/link.md', mode: 120000 as any }]);
      expect(result).toBe(true);
    });

    it('PROVES VULNERABILITY: existing symlink target modification in git diff bypasses symlink check', () => {
      // In git, modifying an existing symlink has diff header `index <hash>..<hash> 120000`
      const patch = `diff --git a/docs/link.md b/docs/link.md
index 1111111..2222222 120000
--- a/docs/link.md
+++ b/docs/link.md
@@ -1 +1 @@
-target1.md
+/etc/passwd`;
      const result = containsExecutableOrSensitiveCode([{ path: 'docs/link.md', patch }]);
      expect(result).toBe(true);
    });

    it('blocks string mode 100755 and new file mode 100755 patches', () => {
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/script.md', mode: '100755' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/script.md', patch: 'new file mode 100755\n+ #!/bin/sh' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/script.md', patch: 'chmod +x docs/script.md' }])).toBe(true);
    });

    it('PROVES VULNERABILITY: numeric mode 100755 bypasses executable check', () => {
      const result = containsExecutableOrSensitiveCode([{ path: 'docs/script.md', mode: 100755 as any }]);
      expect(result).toBe(true);
    });

    it('PROVES VULNERABILITY: executable mode 100775 / 100777 / 775 / 777 bypasses executable check', () => {
      // Group/other executable modes have executable bit set and are strictly checked
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/script.md', mode: '100775' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/script.md', mode: '100777' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/script.md', mode: '775' }])).toBe(true);
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/script.md', mode: '777' }])).toBe(true);
    });

    it('PROVES VULNERABILITY: patch with new mode 100775 bypasses mode change check', () => {
      const patch = `diff --git a/docs/script.md b/docs/script.md
old mode 100644
new mode 100775`;
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/script.md', patch }])).toBe(true);
    });

    it('PROVES VULNERABILITY: existing executable script modification bypasses mode check', () => {
      // In git, modifying an existing executable file has diff header `index <hash>..<hash> 100755`
      const patch = `diff --git a/docs/script.md b/docs/script.md
index 1111111..2222222 100755
--- a/docs/script.md
+++ b/docs/script.md
@@ -1 +1 @@
-echo old
+echo new`;
      expect(containsExecutableOrSensitiveCode([{ path: 'docs/script.md', patch }])).toBe(true);
    });
  });
});
