// The Flux TTS voice catalogue, for the picker in the overlay.
//
// Grouped by accent because that's the first thing anyone filters on. This is
// a static copy of https://developers.deepgram.com/docs/flux-tts/voices — the
// API has no "list voices" endpoint for Flux TTS, so a new voice shipping by
// Deepgram won't appear here until this list is updated. Anything set through
// DEEPGRAM_TTS_VOICE still works whether or not it's listed; the picker adds
// unknown values as an extra option rather than silently dropping them.

export const VOICE_GROUPS = [
  {
    label: "American",
    voices: [
      { id: "flux-haley-en", label: "Haley — clear, professional" },
      { id: "flux-hannah-en", label: "Hannah — confident, thoughtful" },
      { id: "flux-alexis-en", label: "Alexis — calm, empathetic" },
      { id: "flux-sienna-en", label: "Sienna — warm, caring" },
      { id: "flux-brooke-en", label: "Brooke — fast, energetic" },
      { id: "flux-heather-en", label: "Heather — engaging, energetic" },
      { id: "flux-kelsey-en", label: "Kelsey — calm, caring" },
      { id: "flux-paige-en", label: "Paige — clear, comfortable" },
      { id: "flux-elise-en", label: "Elise — professional, calm" },
      { id: "flux-meghan-en", label: "Meghan — friendly, confident" },
      { id: "flux-bree-en", label: "Bree — friendly, kind" },
      { id: "flux-brittany-en", label: "Brittany — confident, soft" },
      { id: "flux-cliff-en", label: "Cliff — deep, raspy" },
      { id: "flux-miles-en", label: "Miles — calm, sincere" },
      { id: "flux-cole-en", label: "Cole — friendly, engaging" },
      { id: "flux-marcus-en", label: "Marcus — smooth, helpful" },
      { id: "flux-wade-en", label: "Wade — warm, enthusiastic" },
      { id: "flux-wes-en", label: "Wes — thoughtful, warm" },
      { id: "flux-bruce-en", label: "Bruce — natural, engaged" },
      { id: "flux-donovan-en", label: "Donovan — professional, calm" },
      { id: "flux-drew-en", label: "Drew — relaxed, soft" },
    ],
  },
  {
    label: "British",
    voices: [
      { id: "flux-kit-en", label: "Kit — friendly, energetic" },
      { id: "flux-colin-en", label: "Colin — warm, authoritative" },
      { id: "flux-gemma-en", label: "Gemma — kind, approachable" },
      { id: "flux-sean-en", label: "Sean — calming, caring" },
      { id: "flux-jack-en", label: "Jack — confident, clear" },
      { id: "flux-rufus-en", label: "Rufus — gentle, enthusiastic" },
      { id: "flux-conor-en", label: "Conor — deep, relaxed" },
      { id: "flux-tanner-en", label: "Tanner — professional, calm" },
    ],
  },
  {
    label: "Irish, Australian",
    voices: [
      { id: "flux-maeve-en", label: "Maeve — Irish, energetic" },
      { id: "flux-sharon-en", label: "Sharon — Australian, relaxed" },
    ],
  },
  {
    label: "Indian, Singaporean, Filipino",
    voices: [
      { id: "flux-priya-en", label: "Priya — Indian, reassuring" },
      { id: "flux-meena-en", label: "Meena — Indian, empathetic" },
      { id: "flux-naveen-en", label: "Naveen — Indian, knowledgeable" },
      { id: "flux-kai-en", label: "Kai — Singaporean, calm" },
      { id: "flux-marcelo-en", label: "Marcelo — Filipino, caring" },
    ],
  },
];

export const isKnownVoice = (id) =>
  VOICE_GROUPS.some((g) => g.voices.some((v) => v.id === id));
