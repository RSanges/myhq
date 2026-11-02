// Built from code points: the repository itself never contains these characters.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

/**
 * Replaces em and en dashes, which MyHQ never writes: a dash between words
 * becomes a comma, any other one a hyphen.
 */
export function replaceDashes(text: string): string {
  let out = text;
  for (const dash of [EM_DASH, EN_DASH]) {
    out = out
      .split(` ${dash} `)
      .join(", ")
      .split(`${dash} `)
      .join(", ")
      .split(` ${dash}`)
      .join(",")
      .split(dash)
      .join("-");
  }
  return out;
}
