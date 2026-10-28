// Status pills drawn as one SVG per row where the surface draws SVG (desktop, VS Code): tinted capsules with a glyph,
// following the app's light or dark scheme. The terminal gets the same pills as coloured words.

import type { ThemeKey } from 'claude-code'

export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'grey' | 'purple'
export type Glyph = 'check' | 'cross' | 'ring' | 'clock' | 'dot' | 'arrow'
export type Pill = { text: string; tone: Tone; glyph?: Glyph; /** For `ring`: the share already done, 0 to 1. */ progress?: number }

/** Ink per tone, light then dark: the text and the glyph; the capsule is the same ink, faint. */
const INK: Record<Tone, [string, string]> = {
  green: ['#1a7f37', '#3fb950'],
  red: ['#cf222e', '#f85149'],
  amber: ['#9a6700', '#d29922'],
  blue: ['#0969da', '#4493f8'],
  grey: ['#59636e', '#9198a1'],
  purple: ['#8250df', '#ab7df8'],
}

/** The character a terminal draws in place of each glyph. */
export const GLYPH_CHAR: Record<Glyph, string> = { check: '✓', cross: '✕', ring: '◌', clock: '◷', dot: '•', arrow: '→' }

/** The theme key a terminal draws each tone with. */
export const TONE_KEY: Record<Tone, ThemeKey> = {
  green: 'success', red: 'error', amber: 'warning', blue: 'suggestion', grey: 'subtle', purple: 'merged',
}

const HEIGHT = 20
const GAP = 6
const ROW_GAP = 6
const PAD = 8
const GLYPH = 10

/** The width of `text` in 11px medium system-ui, close enough to size a capsule; `textLength` absorbs the rest. */
export function textWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    if (ch === ' ') w += 3.1
    else if ('ijlt.,:;\'|!f1rI'.includes(ch)) w += 3.6
    else if ('mwMW'.includes(ch)) w += 9.2
    else if (/[A-Z]/.test(ch)) w += 7.3
    else if (/[0-9]/.test(ch)) w += 6.4
    else w += 6.1
  }
  return Math.ceil(w)
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;')

/** A glyph centred in a 10×10 box at (x, y), drawn in the tone's ink (currentColor). */
function glyphOf(glyph: Glyph, x: number, y: number, progress = 0): string {
  const cx = x + 5
  const cy = y + 5
  switch (glyph) {
    case 'check':
      return `<path d='M${x + 1.5} ${cy}l2.5 2.5l4.5-5' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/>`
    case 'cross':
      return `<path d='M${x + 2} ${y + 2}l6 6M${x + 8} ${y + 2}l-6 6' stroke='currentColor' stroke-width='1.6' stroke-linecap='round'/>`
    case 'dot':
      return `<circle cx='${cx}' cy='${cy}' r='3' fill='currentColor'/>`
    case 'clock':
      return `<circle cx='${cx}' cy='${cy}' r='4.2' fill='none' stroke='currentColor' stroke-width='1.3'/><path d='M${cx} ${cy - 2.4}v2.6l1.8 1.1' fill='none' stroke='currentColor' stroke-width='1.3' stroke-linecap='round'/>`
    case 'arrow':
      return `<path d='M${x + 1} ${cy}h7M${x + 5} ${y + 2}l3 3l-3 3' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/>`
    case 'ring': {
      // A track and the share done as an arc from twelve o'clock: how far the checks have got.
      const r = 4.2
      const share = Math.max(0.04, Math.min(0.999, progress))
      const a = share * 2 * Math.PI
      const ex = (cx + r * Math.sin(a)).toFixed(2)
      const ey = (cy - r * Math.cos(a)).toFixed(2)
      return `<circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke='currentColor' stroke-opacity='.3' stroke-width='1.6'/>` +
        `<path d='M${cx} ${cy - r}A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${ex} ${ey}' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round'/>`
    }
  }
}

/** Pills laid in rows no wider than `maxWidth` CSS pixels, as one SVG document. */
export function pillsSvg(pills: readonly Pill[], maxWidth: number): { source: string; width: number; height: number } {
  const shapes: string[] = []
  const tones = new Set<Tone>()
  let x = 0
  let y = 0
  let width = 0
  for (const pill of pills) {
    const text = textWidth(pill.text)
    const lead = pill.glyph ? GLYPH + 5 : 0
    const w = PAD + lead + text + PAD
    if (x > 0 && x + w > maxWidth) {
      x = 0
      y += HEIGHT + ROW_GAP
    }
    tones.add(pill.tone)
    shapes.push(
      `<g class='${pill.tone}'>` +
      `<rect x='${x + 0.5}' y='${y + 0.5}' width='${w - 1}' height='${HEIGHT - 1}' rx='${(HEIGHT - 1) / 2}'/>` +
      (pill.glyph ? glyphOf(pill.glyph, x + PAD, y + (HEIGHT - GLYPH) / 2, pill.progress) : '') +
      `<text x='${x + PAD + lead}' y='${y + 14}' textLength='${text}' lengthAdjust='spacingAndGlyphs'>${escapeXml(pill.text)}</text>` +
      '</g>',
    )
    width = Math.max(width, x + w)
    x += w + GAP
  }
  const light = [...tones].map(t => `.${t}{color:${INK[t][0]}}`).join('')
  const dark = [...tones].map(t => `.${t}{color:${INK[t][1]}}`).join('')
  const height = pills.length ? y + HEIGHT : 0
  // Single quotes: the source crosses as JSON, where each double quote costs an escape.
  const source =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>` +
    `<style>rect{fill:currentColor;fill-opacity:.12;stroke:currentColor;stroke-opacity:.4}` +
    `text{fill:currentColor;font:500 11px -apple-system,system-ui,sans-serif}${light}` +
    `@media(prefers-color-scheme:dark){${dark}rect{fill-opacity:.18}}</style>${shapes.join('')}</svg>`
  return { source, width, height }
}

/** A small spinner for a fetch in flight; SMIL, so drawn with `isInteractive`. */
export const SPINNER_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 16 16'>" +
  '<style>.t{stroke:#d0d7de}.a{stroke:#59636e}@media(prefers-color-scheme:dark){.t{stroke:#3d444d}.a{stroke:#9198a1}}</style>' +
  "<circle class='t' cx='8' cy='8' r='6' fill='none' stroke-width='2'/>" +
  "<path class='a' d='M8 2a6 6 0 0 1 6 6' fill='none' stroke-width='2' stroke-linecap='round'>" +
  "<animateTransform attributeName='transform' type='rotate' from='0 8 8' to='360 8 8' dur='0.9s' repeatCount='indefinite'/></path></svg>"
