"use client";

/**
 * Digits-only money field with a $ prefix. The text is always shown with thousands separators:
 * switching between raw and formatted text on focus would shift the caret and corrupt edits.
 */
export default function MoneyInput({ value, onChange, label, placeholder, describedBy }: { value: string; onChange: (digits: string) => void; label: string; placeholder?: string; describedBy?: string }) {
  return <span className="mortgage-money">
    <span aria-hidden="true">$</span>
    <input
      inputMode="numeric"
      aria-label={label}
      placeholder={placeholder}
      aria-describedby={describedBy}
      value={value === "" ? "" : Number(value).toLocaleString("en-CA")}
      onChange={event => onChange(event.target.value.replace(/\D/g, ""))}
    />
  </span>;
}
