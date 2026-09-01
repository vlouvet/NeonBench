import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Tier 3 #105 — ban the raw numeric input.
//
// `<input type="number">` with a numeric `step` makes `min` the base of a
// lattice of valid values. A value off that lattice fails HTML constraint
// validation, and inside a `<form>` that silently swallows the submit: no
// exception, no console warning, no state change, just a button that does
// nothing. It shipped in PR #146 and again in PR #158, weeks apart, with the
// hazard already written into CLAUDE.md as prose. Prose did not work, so it
// is a lint error now.
//
// `web/src/components/NumericField.tsx` is the sanctioned wrapper: it
// defaults to `step="any"` and offers `integer` for genuine counters.
//
// NOTE ON THE SELECTOR: it matches the literal attribute `type="number"`.
// A computed type (`type={someVar}`) slips past it, as does a hand-rolled
// `React.createElement('input', { type: 'number' })`. Neither pattern exists
// in this repo, and a selector that tried to catch them would be guesswork;
// the rule is a tripwire on the shape people actually write, not a proof.
export const NUMERIC_INPUT_RULE = {
  selector:
    "JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value='number']",
  message:
    'Raw <input type="number"> is banned (todo.md row 105). A numeric `step` makes `min` a lattice base, ' +
    'and an off-lattice value silently swallows the form submit — it shipped that way twice (PR #146, PR #158). ' +
    'Use <NumericField> from src/components/NumericField.tsx: it defaults to step="any", and takes `integer` ' +
    'when the quantity really is a discrete counter.',
}

// The one file where the raw element is tolerated: the wrapper itself, since
// it is what the rule points everyone at. Kept as a named export because
// `eslint.config.test.js` asserts this list is exactly one entry.
//
// THE LIST DOES NOT GROW. Tier 3 #112 removed the last two entries
// (`src/pages/EditorPage.tsx` and `src/components/ArrangePanel.tsx`, held
// back by row 105 because they were being rewritten on a parallel branch) and
// migrated their 12 call sites to <NumericField>. Adding a path back is never
// the fix for a lint error here: an exempted file is invisible to the rule,
// not merely quieter. While EditorPage was exempt its raw-input count went
// from 4 to 8 (PR #165) with every check in the repo green, and the count
// this comment used to quote was stale by the time anyone read it. Fix the
// call site, or extend <NumericField> until it can serve the call site.
//
// The rule is `error` everywhere else and is NOT downgraded to a warning
// anywhere — a warning is precisely how the prose version of this rule
// failed.
export const NUMERIC_INPUT_EXEMPT_FILES = ['src/components/NumericField.tsx']

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-restricted-syntax': ['error', NUMERIC_INPUT_RULE],
    },
  },
  {
    files: NUMERIC_INPUT_EXEMPT_FILES,
    rules: {
      // `'off'`, not `['error']` with an empty selector list: ESLint treats a
      // severity-only rule entry as "keep the inherited options", so
      // `['error']` would have left the ban fully in force here. That is not
      // a hypothetical — it is what this override did on the first attempt,
      // and `--print-config` was what caught it.
      'no-restricted-syntax': 'off',
    },
  },
])
