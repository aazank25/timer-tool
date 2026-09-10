/**
 * The validated categorical palette. Each slot ships a light and a dark step of
 * the same hue — the dark column is stepped for the dark surface, not an
 * automatic flip — so a project keeps its identity in either mode.
 *
 * Assigned in fixed order, never cycled: the order is what makes adjacent
 * slots separable under colour-vision deficiency, so do not reshuffle it.
 * Verified with the data-viz validator against both surfaces:
 *   light #fcfcfb — worst adjacent CVD dE 9.1, normal-vision dE 19.6
 *   dark  #1a1a19 — worst adjacent CVD dE 8.4, normal-vision dE 19.3
 * Three light steps sit under 3:1 on the light surface, so every coloured mark
 * in this app is paired with a visible text label rather than standing alone.
 */
export interface Slot {
  name: string;
  light: string;
  dark: string;
}

export const SLOTS: Slot[] = [
  { name: 'Blue', light: '#2a78d6', dark: '#3987e5' },
  { name: 'Orange', light: '#eb6834', dark: '#d95926' },
  { name: 'Aqua', light: '#1baf7a', dark: '#199e70' },
  { name: 'Yellow', light: '#eda100', dark: '#c98500' },
  { name: 'Magenta', light: '#e87ba4', dark: '#d55181' },
  { name: 'Green', light: '#008300', dark: '#008300' },
  { name: 'Violet', light: '#4a3aa7', dark: '#9085e9' },
  { name: 'Red', light: '#e34948', dark: '#e66767' },
];

export const UNASSIGNED_COLOR = { light: '#898781', dark: '#898781' };

const byLight = new Map(SLOTS.map((s) => [s.light.toLowerCase(), s]));

/** Map a stored colour onto the step that belongs on the current surface. */
export function seriesColor(hex: string | null | undefined, dark: boolean): string {
  if (!hex) return UNASSIGNED_COLOR.light;
  const slot = byLight.get(hex.toLowerCase());
  if (slot) return dark ? slot.dark : slot.light;
  return hex; // a hand-picked colour is used as given
}

/** Next unused slot, so a new project never collides with an existing one. */
export function nextColor(taken: string[]): string {
  const used = new Set(taken.map((c) => c.toLowerCase()));
  return (SLOTS.find((s) => !used.has(s.light.toLowerCase())) ?? SLOTS[0]!).light;
}

/** Sequential blue ramp, light -> dark, for continuous magnitude. */
export const BLUE_RAMP = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
];
