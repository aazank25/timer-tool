/**
 * Error text that can be read in both themes. The red of --critical reads on a light surface, but
 * on the dark ones it falls to 3.3 to 3.6:1, short of the 4.5:1 that text this small needs.
 * Mixing some --ink into it (near black in the light theme, white in the dark one) darkens it in
 * the first and lightens it in the second, so each theme gets the contrast it lacks without a
 * token of its own. The words carry the meaning; the colour only agrees with them.
 */
export const errorText = 'text-[color-mix(in_srgb,var(--critical)_70%,var(--ink))]';
