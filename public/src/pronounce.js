// Pronunciation fixes for text on its way to text-to-speech.
//
// Flux TTS has no pronunciation control at all: there is no lexicon, no phoneme
// input, and SSML is actively discarded — recognized tags are stripped with an
// INPUT_MARKUP_STRIPPED warning and synthesis carries on regardless. Deepgram
// lists inline IPA controls as "coming soon". Until then the only lever is the
// text itself, and Deepgram's own guidance is to respell problem words
// phonetically before sending them.
//
// This runs ONLY on the string handed to /v2/speak. The transcript in the
// overlay still shows what was actually said, so the respelling never leaks
// into the UI.
//
// Respellings are judged by ear, not by rule — if one still sounds wrong, try
// another spelling here rather than reaching for markup, which will be stripped.

/** Lower-case word -> how it should be spelled for the synthesizer. */
export const PRONUNCIATIONS = {
  // Said with a short "i" by default; wants /ˈsaɪloʊ/.
  silo: "sigh-low",
  silos: "sigh-lows",
};

// Longest first, so a longer entry always wins over a shorter one that prefixes
// it. \b handles "silo" vs "silos" on its own, but ordering keeps that true for
// entries added later where the boundary doesn't separate them.
const WORDS = Object.keys(PRONUNCIATIONS).sort((a, b) => b.length - a.length);
const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERN = WORDS.length
  ? new RegExp(`\\b(${WORDS.map(escape).join("|")})\\b`, "gi")
  : null;

/** Carry the original word's casing over to the replacement. */
function matchCase(original, replacement) {
  if (original === original.toUpperCase() && /[A-Z]/.test(original)) {
    return replacement.toUpperCase();
  }
  if (original[0] === original[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Apply the pronunciation map. Returns the text unchanged when nothing matches,
 * which is the overwhelmingly common case.
 */
export function respell(text) {
  if (!PATTERN || !text) return text;
  return text.replace(PATTERN, (word) =>
    matchCase(word, PRONUNCIATIONS[word.toLowerCase()])
  );
}
