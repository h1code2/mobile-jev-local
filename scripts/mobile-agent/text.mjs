// Jev selects source text; it never invents a field value. Explicit --text values take precedence.
// Whitespace sliding windows cover space-separated goals; script-boundary atoms
// cover CJK goals, which have no spaces — "使用chrome浏览器打开baidu.com" must still
// yield "baidu.com" and "chrome" as exact substrings of the goal.
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
  return { values: [...values], source: 'goal', overflow: false };
}
