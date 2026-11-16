import type { ReactNode } from "react";

/** A table header with its unit on a second line ("Volume" / "litres"), so every header is two lines and the
 *  columns line up. With no unit the second line is kept empty. */
export function ColHead({ name, unit }: { name: ReactNode; unit?: ReactNode }) {
  return (
    <>
      <span className="th-name">{name}</span>
      <span className="th-unit">{unit ?? " "}</span>
    </>
  );
}
