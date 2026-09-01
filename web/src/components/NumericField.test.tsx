import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ESLint } from 'eslint';
import { NumericField } from './NumericField';

// Tier 3 #105. Two halves, and both matter:
//
//   1. The component renders `step="any"` unless the caller explicitly asks
//      for the integer lattice.
//   2. The lint rule that funnels everyone into the component actually
//      fires. A banned-syntax rule whose selector has drifted is exactly the
//      "test that silently stops testing" failure CLAUDE.md calls out — it
//      reports success while guarding nothing.
//
// There is no DOM test environment in this repo by design, so the render
// assertions go through `renderToStaticMarkup` and read the emitted HTML.
// That is the right altitude here anyway: `step` is an HTML attribute, and
// the attribute is the whole subject of the test.

describe('NumericField', () => {
  it('defaults to step="any"', () => {
    const html = renderToStaticMarkup(<NumericField min={1} value={500} readOnly />);
    expect(html).toContain('step="any"');
    expect(html).toContain('type="number"');
  });

  it('renders step="1" when the caller declares an integer counter', () => {
    const html = renderToStaticMarkup(<NumericField integer min={1} value={3} readOnly />);
    expect(html).toContain('step="1"');
  });

  it('cannot be talked out of type=number or a safe step by a spread', () => {
    // The prop types forbid `type` and `step`, but a `{...record}` spread
    // from loosely typed data could still carry one at runtime. The
    // component applies both attributes after the spread precisely so that
    // this cannot regress into the bug the component exists to prevent.
    const smuggled = { type: 'text', step: 0.05 } as unknown as Record<string, unknown>;
    const html = renderToStaticMarkup(<NumericField min={0} value={6.35} readOnly {...smuggled} />);
    expect(html).toContain('type="number"');
    expect(html).toContain('step="any"');
    expect(html).not.toContain('step="0.05"');
  });

  it('forwards ids, labels, aria attributes and other input props', () => {
    const html = renderToStaticMarkup(
      <NumericField
        id="cap-height"
        aria-label="Cap height millimetres"
        className="est-input-sm"
        placeholder="auto"
        min={1}
        max={500}
        disabled
        readOnly
        value={100}
      />,
    );
    expect(html).toContain('id="cap-height"');
    expect(html).toContain('aria-label="Cap height millimetres"');
    expect(html).toContain('class="est-input-sm"');
    expect(html).toContain('placeholder="auto"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="500"');
    expect(html).toContain('disabled');
  });

  // The values that motivated the whole exercise. Every one of these is a
  // real trade dimension an operator types, and every one is off the lattice
  // that the pre-#105 code declared for its field. `step="any"` is what
  // makes them submittable.
  it.each([
    ['½ in tube diameter', 12.7],
    ['⅜ in tube diameter', 9.525],
    ['⅛ in end gap', 3.175],
    ['3 in channel letter depth', 76.2],
    ['1 in lead-in', 25.4],
  ])('accepts %s (%s mm) without a step lattice', (_label, mm) => {
    const html = renderToStaticMarkup(<NumericField min={0} value={mm} readOnly />);
    expect(html).toContain('step="any"');
    expect(html).toContain(`value="${mm}"`);
  });
});

describe('the no-restricted-syntax rule behind NumericField', () => {
  // Lint the source text through the repo's real flat config, so the test
  // exercises the same selector CI does rather than a copy of it.
  async function lint(code: string, filePath: string) {
    const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname });
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
  }

  const RAW = `export function Bad() {\n  return <input type="number" min={1} step={10} />;\n}\n`;

  it('fires on a raw <input type="number">', async () => {
    const messages = await lint(RAW, 'src/components/zz-lint-probe.tsx');
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(2); // error, never a warning
    expect(messages[0].message).toContain('row 105');
    expect(messages[0].message).toContain('NumericField');
  });

  // The negative control CLAUDE.md asks for: a rule that fires on everything
  // is as useless as one that fires on nothing. Seeing the clean case pass
  // is what makes the failing case above mean something.
  it('does not fire on NumericField or on other input types', async () => {
    const good =
      `import { NumericField } from './NumericField';\n` +
      `export function Good() {\n` +
      `  return <><NumericField min={1} /><input type="text" /><input type="range" step={0.5} /></>;\n` +
      `}\n`;
    expect(await lint(good, 'src/components/zz-lint-probe.tsx')).toHaveLength(0);
  });

  it('exempts exactly one file: the wrapper', async () => {
    // Asserted against the RESOLVED config for every source file, not
    // against the exported list, so it measures the rule's actual reach. If
    // someone exempts another file to make their lint error go away, this
    // fails and makes them say so out loud. EditorPage.tsx and
    // ArrangePanel.tsx were the row 105 follow-up; Tier 3 #112 migrated
    // their call sites and removed them, so the list is now at its floor.
    // `eslint.config.test.js` pins the exported list and scans src for the
    // element itself — the check an exempted file could never get.
    const cwd = new URL('../..', import.meta.url).pathname;
    const eslint = new ESLint({ cwd });
    // `import.meta.glob` rather than a filesystem walk: `src` is browser
    // code and its tsconfig deliberately excludes node types. Keys come back
    // root-relative ('/src/...'); nothing is imported, only enumerated.
    const files = Object.keys(import.meta.glob('/src/**/*.tsx'))
      .map((f) => f.replace(/^\//, ''))
      .filter((f) => !f.endsWith('.test.tsx'))
      .sort();
    expect(files.length).toBeGreaterThan(20); // guard against a vacuous glob

    const exempt: string[] = [];
    for (const f of files) {
      const config = await eslint.calculateConfigForFile(f);
      const severity = config.rules?.['no-restricted-syntax']?.[0];
      // Severity must be error everywhere it is on: never softened to a
      // warning, which is how the prose version of this rule failed.
      if (severity === 0) exempt.push(f);
      else expect(severity).toBe(2);
    }

    expect(exempt).toEqual(['src/components/NumericField.tsx']);
  });
});
