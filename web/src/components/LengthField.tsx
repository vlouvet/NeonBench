import { useRef, useState, type ComponentPropsWithRef } from 'react';
import { lengthFieldText, resolveLengthEdit, type DisplayUnits } from '../lib/units';

// Tier 3 #152 — a sign dimension an operator can type the way they write it.
// In an inch project that means `4' 6"` or `48 1/2`, which a number input
// cannot hold, so this is a text input. It is for dimensions only: glass
// (diameter, end gap, bend radius) stays in NumericField and in millimetres.
//
// The value stays millimetres at every boundary. A write happens only when the
// operator types, never on focus or blur, so tabbing through a field cannot
// nudge a stored value by rounding it through the display.

type Props = Omit<ComponentPropsWithRef<'input'>, 'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'> & {
  valueMM: number | null | undefined;
  units: DisplayUnits;
  onChangeMM: (mm: number) => void;
  /** Called when the field is cleared. Without it, empty counts as invalid. */
  onClear?: () => void;
  /** Reject zero and negative values, as a cap height must. */
  positive?: boolean;
};

export function LengthField({
  valueMM,
  units,
  onChangeMM,
  onClear,
  positive = false,
  onFocus,
  onBlur,
  ...rest
}: Props) {
  // The text being typed; null when the field is not being edited.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // The value when editing began, so retyping its text restores it exactly.
  const baselineRef = useRef(valueMM);

  return (
    <input
      {...rest}
      type="text"
      autoComplete="off"
      aria-invalid={invalid || undefined}
      value={draft ?? lengthFieldText(valueMM, units)}
      onFocus={(e) => {
        baselineRef.current = valueMM;
        setDraft(lengthFieldText(valueMM, units));
        onFocus?.(e);
      }}
      onBlur={(e) => {
        // Unreadable text is dropped; the last good value is still in place.
        setDraft(null);
        setInvalid(false);
        onBlur?.(e);
      }}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const edit = resolveLengthEdit(text, units, baselineRef.current);
        if (edit.kind === 'value' && !(positive && edit.mm <= 0)) {
          setInvalid(false);
          onChangeMM(edit.mm);
        } else if (edit.kind === 'empty' && onClear) {
          setInvalid(false);
          onClear();
        } else {
          setInvalid(true);
        }
      }}
    />
  );
}
