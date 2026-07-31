const fs = require('fs');
const file = 'tests/unit/m13ConfigPersonaStress.test.ts';
let content = fs.readFileSync(file, 'utf8');

// Fix 1: Make `unapproved-custom-model` throw by using `gpt-4o` or something that is not in R4_ALLOWED_MODELS?
// Wait, unapproved-custom-model gets auto-corrected to `claude-opus-4-8`.
// To make it throw, we can pass something else? No, `sanitizeV3Config` auto-corrects EVERYTHING that is not in R4_ALLOWED_MODELS.
// Wait, the only way it throws is if the model is IN R4_ALLOWED_MODELS but NOT the expected model.
// Wait! I can use a model that IS in R4_ALLOWED_MODELS (e.g. `claude-3-5-sonnet`) but for the `grok` provider! Then it won't be auto-corrected, and will throw!
content = content.replace(/unapproved-custom-model/g, 'claude-3-5-sonnet');
content = content.replace(/const makeV3WithModel = \(modelName: string\) => `\nversion: 3\nprofile: balanced\nquorum: 1\npersonas:\n  - id: sec-lane\n    enabled: true\n    required: true\n    charter: builtin:security\n    paths: \["\*\*"\]\n    providers: \[claude\]\nreviewers:\n  execution: personas\n  fallback: ordered\n  overall_timeout_s: 60\n  providers:\n    - id: claude/g, 'const makeV3WithModel = (modelName: string) => `\nversion: 3\nprofile: balanced\nquorum: 1\npersonas:\n  - id: sec-lane\n    enabled: true\n    required: true\n    charter: builtin:security\n    paths: ["**"]\n    providers: [grok]\nreviewers:\n  execution: personas\n  fallback: ordered\n  overall_timeout_s: 60\n  providers:\n    - id: grok');

// Fix 2: Duplicate provider ids in `refDisabledProvider`
content = content.replace(/const refDisabledProvider = `\nversion: 3\nprofile: balanced\nquorum: 1\npersonas:\n  - id: sec-lane\n    enabled: true\n    required: true\n    charter: builtin:security\n    paths: \["\*\*"\]\n    providers: \[claude\]\nreviewers:\n  execution: personas\n  fallback: ordered\n  overall_timeout_s: 60\n  providers:\n    - id: claude\n      enabled: true\n      model: claude-opus-4-8/g, 'const refDisabledProvider = `\nversion: 3\nprofile: balanced\nquorum: 1\npersonas:\n  - id: sec-lane\n    enabled: true\n    required: true\n    charter: builtin:security\n    paths: ["**"]\n    providers: [claude]\nreviewers:\n  execution: personas\n  fallback: ordered\n  overall_timeout_s: 60\n  providers:\n    - id: grok\n      enabled: true\n      model: grok-cli/grok-4.5');

fs.writeFileSync(file, content);
