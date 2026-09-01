import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { NUMERIC_INPUT_RULE, NUMERIC_INPUT_EXEMPT_FILES } from './eslint.config.js';

// Tier 3 #112 — the guard the comment above `NUMERIC_INPUT_EXEMPT_FILES` has
// always advertised ("kept as a named export so the test suite can assert the
// list has not quietly grown"). Nothing imported the export until this file.
//
// WHY THIS IS THE DURABLE HALF OF #112
//
// Migrating the 12 call sites was a one-time cleanup. What allowed those call
// sites to accumulate is that an exempted file is INVISIBLE to the rule: while
// `EditorPage.tsx` was on the list, PR #165 added four more raw numeric inputs
// to it and every check in the repo stayed green. The documented count in the
// config ("8 raw numeric inputs between them, EditorPage 4") was wrong by the
// time anyone read it.
//
// `NumericField.test.tsx` already asserts the RESOLVED severity for every
// source file, which pins where the rule is switched off. The two tests here
// are the other half:
//
//   1. the exemption list itself is exactly one entry, so the fix for a lint
//      error can never be "add my file to the list";
//   2. the banned element does not appear anywhere under `src`, INCLUDING in
//      the file that is legitimately exempt from the config's point of view —
//      which is the check that would have caught PR #165's four additions on
//      the day they landed, and that catches a file which does not exist yet.
//
// One is a module import, the other a scan of the source text. That is
// deliberate: there is no DOM test environment in this repo (`vite.config.ts`
// declares no `test` block and neither jsdom nor testing-library is a
// dependency), so nothing here needs one.

const WRAPPER = 'src/components/NumericField.tsx';

describe('the raw numeric-input ban', () => {
  it('exempts exactly one file: the wrapper itself', () => {
    expect(
      NUMERIC_INPUT_EXEMPT_FILES,
      'A file was added to NUMERIC_INPUT_EXEMPT_FILES. That is never the fix.\n' +
        'Exempting a file does not silence one input — it switches the rule off for the\n' +
        'whole file forever, and the next four raw inputs land there unnoticed (this is\n' +
        'exactly what happened to EditorPage.tsx between PR #164 and PR #165).\n' +
        'Fix the call site with <NumericField>, or extend <NumericField> so it can serve\n' +
        'the call site. The list stays at one entry: the wrapper itself.',
    ).toEqual([WRAPPER]);
  });

  it('has no raw <input type="number"> anywhere under src, wrapper aside', () => {
    // Run the REAL rule object from the config over every source file, with
    // no exemptions and with `allowInlineConfig: false` so that neither an
    // entry in the exempt list nor an `// eslint-disable-next-line` comment
    // can buy a pass. `npm run lint` measures the rule as configured; this
    // measures the invariant the rule exists to protect.
    const linter = new Linter();
    const config = [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
        },
        rules: { 'no-restricted-syntax': ['error', NUMERIC_INPUT_RULE] },
      },
    ];

    // `import.meta.glob` rather than a filesystem walk, matching
    // `NumericField.test.tsx`: `src` is browser code and its tsconfig
    // deliberately excludes node types. `?raw` hands back the source text.
    // Test files are excluded because the lint-rule tests necessarily quote
    // the banned element as data.
    const sources = Object.entries(
      import.meta.glob('/src/**/*.tsx', { query: '?raw', import: 'default', eager: true }),
    )
      .map(([path, code]) => [path.replace(/^\//, ''), code])
      .filter(([path]) => !path.endsWith('.test.tsx'))
      .sort(([a], [b]) => a.localeCompare(b));

    expect(sources.length, 'vacuous glob: no sources found').toBeGreaterThan(20);

    const counts = {};
    for (const [path, code] of sources) {
      const messages = linter.verify(code, config, { filename: path, allowInlineConfig: false });
      // A mis-scoped flat config makes `verify` return a severity-1 "No
      // matching configuration found" warning and lint NOTHING, which reads
      // as a clean pass. A parse failure looks the same. Fail loudly on any
      // message that is not the rule firing.
      const noise = messages.filter((m) => m.ruleId !== 'no-restricted-syntax');
      expect(
        noise.map((m) => m.message),
        `${path} was not actually linted — the scan is measuring nothing`,
      ).toEqual([]);
      const hits = messages.length;
      if (hits > 0) counts[path] = hits;
    }

    // Positive control: the wrapper is the one file that must still contain
    // the raw element (it is what the rule points everyone at). If this stops
    // being reported, the scan has broken, not the codebase.
    expect(counts[WRAPPER], "the scan no longer finds the wrapper's own raw input").toBe(1);

    expect(
      Object.keys(counts),
      'A raw <input type="number"> is back under web/src.\n' +
        'A numeric `step` makes `min` the base of a lattice of valid values, and a value\n' +
        'off that lattice fails HTML constraint validation — inside a <form> that swallows\n' +
        'the submit with no error and no console warning. It shipped that way in PR #146\n' +
        'and again in PR #158. Use <NumericField> (src/components/NumericField.tsx):\n' +
        'it renders step="any", and takes `integer` for a genuine discrete counter.',
    ).toEqual([WRAPPER]);
  });
});
