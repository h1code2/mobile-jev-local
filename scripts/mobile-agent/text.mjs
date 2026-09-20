// Jev selects source text; it never invents a field value. Explicit --text values take precedence.
// Whitespace sliding windows cover space-separated goals. CJK goals have no
// spaces, so short contiguous Han spans let Jev select "时间" from a goal such
// as "修改手机时间" without inventing text.
export function textCandidates(goal, supplied = []) {
  if (supplied.length)
    return { values: [...new Set(supplied)], source: 'supplied', overflow: false };
  const values = new Set();
  const words = [...goal.matchAll(/\S+/gu)];
  for (let length = 1; length <= Math.min(8, words.length); length++) {
    for (let start = 0; start + length <= words.length; start++) {
      const end = words[start + length - 1];
      const value = goal
        .slice(words[start].index, end.index + end[0].length)
        .replace(/^["'“‘([{]+|["'”’)\]},.!?;:]+$/gu, '')
        .trim();
      if (value) values.add(value);
      if (values.size > 254) return { values: [], source: 'goal', overflow: true };
    }
  }
  for (const atom of goal.matchAll(/[A-Za-z0-9][A-Za-z0-9._@:-]*/gu)) {
    values.add(atom[0]);
    if (values.size > 254) return { values: [], source: 'goal', overflow: true };
  }
  for (const match of goal.matchAll(/\p{Script=Han}{2,}/gu)) {
    const chars = [...match[0]];
    for (let length = 2; length <= Math.min(12, chars.length); length++) {
      for (let start = 0; start + length <= chars.length; start++) {
        values.add(chars.slice(start, start + length).join(''));
        if (values.size > 254) return { values: [], source: 'goal', overflow: true };
      }
    }
  }
  return { values: [...values], source: 'goal', overflow: false };
}
