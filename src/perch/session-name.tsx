// A session's display name. When the name tells sessions with the same project apart by its end (the folder's label,
// the rest of a session name, the number), only the start is cut with "…" when it doesn't fit, so that end stays
// visible (docs/design.md "Display names"). The element around it gets sessionNameClass, which lays the two parts out
const splitOf = (name: string, suffix: string | undefined) =>
  suffix && suffix.length < name.length && name.endsWith(suffix) ? name.length - suffix.length : undefined;

/** The class for the element around SessionName ("" when the name isn't split) */
export const sessionNameClass = (name: string, suffix: string | undefined) =>
  splitOf(name, suffix) === undefined ? "" : " session-name-split";

export function SessionName({ name, suffix }: { name: string; suffix?: string }) {
  const at = splitOf(name, suffix);
  if (at === undefined) return <>{name}</>;
  return (
    <>
      <span className="session-name-head">{name.slice(0, at)}</span>
      <span className="session-name-tail">{name.slice(at)}</span>
    </>
  );
}
