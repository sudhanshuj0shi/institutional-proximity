// Flags unsupported, inflammatory labels the editorial policy forbids (spec §3.1/§3.3).
// This is an aid to reviewers, not a substitute for editorial judgement.
const PATTERNS: [RegExp, string][] = [
  [/\bcorrupt(ion|ed)?\b/i, "corrupt"],
  [/\bpuppet\b/i, "puppet"],
  [/\bstooges?\b/i, "stooge"],
  [/\bcompromised\b/i, "compromised"],
  [/\bbought\b/i, "bought"],
  [/\bbiased\b/i, "biased"],
  [/\bgovernment[- ]controlled\b/i, "government-controlled"],
  [/\bpolitical connections?\b/i, "political connection"],
  [/\bcrony|cronies\b/i, "crony"],
  [/\bloyalist\b/i, "loyalist"],
  [/\breward(ed)? for\b/i, "rewarded for"],
  [/\bquid pro quo\b/i, "quid pro quo"],
];

export function languageWarnings(text: string): string[] {
  const hits = PATTERNS.filter(([re]) => re.test(text)).map(([, w]) => `"${w}"`);
  if (hits.length === 0) return [];
  return [`This text uses ${hits.join(", ")}. Unless it is an exact quotation of an official finding, rephrase it to describe only what the source establishes.`];
}
