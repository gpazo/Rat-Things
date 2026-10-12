export const directions = {
  paper: {
    name: 'Paper & ink',
    prompt: 'Warm editorial: cream paper, terracotta accents, generous space, expressive serif headlines. Quiet, tactile, thoughtful.',
  },
  midnight: {
    name: 'After hours',
    prompt: 'Bold after-hours: deep navy, electric lime accents, large geometric sans-serif headlines, rounded cards. Confident, vivid, energetic.',
  },
  studio: {
    name: 'Studio blue',
    prompt: 'Modern Swiss studio: ivory and saturated cobalt blue, disciplined grid, crisp sans-serif type, numbered sections, restrained geometric details. Clear, purposeful, spacious.',
  },
  sage: {
    name: 'Soft sage',
    prompt: 'Quiet botanical: warm white, soft sage and forest green, friendly rounded sans-serif type, gently rounded cards, subtle leaf-like CSS shapes. Welcoming, calm, natural, with strong readable contrast.',
  },
  index: {
    name: 'Index',
    prompt: 'Minimal index-card system: near-white, charcoal, a small amber accent, compact monospace labels paired with clean sans-serif headlines, thin rules, squared cards, generous whitespace. Precise, useful, uncluttered; no terminal or developer-tool aesthetic.',
  },
} as const;

export type Theme = keyof typeof directions;
export const allThemes = Object.keys(directions) as Theme[];
