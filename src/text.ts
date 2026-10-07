/** Slice within a UTF-16 budget without retaining half a surrogate pair. */
export function sliceText(text: string, start = 0, end = text.length): string {
  const at = (index: number): number =>
    Math.min(text.length, Math.max(0, index < 0 ? text.length + Math.trunc(index) : Math.trunc(index)));
  let left = at(start);
  let right = at(end);
  const high = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
  const low = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
  if (left > 0 && low(text.charCodeAt(left)) && high(text.charCodeAt(left - 1))) left += 1;
  if (right > 0 && high(text.charCodeAt(right - 1)) && low(text.charCodeAt(right))) right -= 1;
  return text.slice(left, Math.max(left, right));
}
