/**
 * AIA Qi Design System — React Native tokens.
 *
 * Source of truth: https://design.aia.com/aia-qi-design-system
 * See also the canonical token reference in
 * /Users/hcsrazl/.claude/skills/AIA-digital-design/SKILL.md
 *
 * Notes for RN:
 * - No CSS variables; consume these constants directly in StyleSheet.
 * - Fonts: Qi uses Montserrat (heading) + Open Sans (body). For this POC
 *   we fall back to the iOS system font. To bundle the brand fonts later,
 *   add the .ttf files and run `npx react-native-asset`.
 * - Dark theme tokens omitted here (light theme matches the mockup).
 */

export const colors = {
  brand: {
    red: '#e00842', // AIA Red — primary CTAs, accents, links
    redHover: '#b30635',
    navy: '#082065', // selected/active states only
  },
  surface: {
    page: '#f5f7f9', // page background
    default: '#ffffff', // cards, overlays
    alternate: '#f5f5f6',
  },
  text: {
    default: '#14181c',
    subdued: '#666e75',
    disabled: '#858b91',
    inverse: '#ffffff',
    link: '#e00842',
  },
  border: {
    subtle: '#e0e3e6',
    focus: '#0c6dd2',
  },
  status: {
    success: '#229f64',
    warning: '#f7c926',
    error: '#d40c74',
  },
} as const;

/** 4 px base grid; prefer 8 px increments. */
export const spacing = {
  s4: 4,
  s8: 8,
  s12: 12,
  s16: 16,
  s24: 24,
  s32: 32,
  s40: 40,
  s80: 80,
} as const;

export const radius = {
  sm: 4, // checkboxes
  md: 8, // buttons, cards, inputs
  lg: 16, // dialogs, overlays, hero imagery
  pill: 999,
} as const;

/**
 * Qi type scale (size / line-height / weight).
 * Use `as TextStyle` at the call site if TS narrows fontWeight.
 */
export const typography = {
  h1: {fontSize: 32, lineHeight: 42, fontWeight: '600' as const},
  h2: {fontSize: 28, lineHeight: 36, fontWeight: '600' as const},
  h3: {fontSize: 24, lineHeight: 32, fontWeight: '600' as const},
  h4: {fontSize: 22, lineHeight: 28, fontWeight: '600' as const},
  h5: {fontSize: 20, lineHeight: 26, fontWeight: '600' as const},
  h6: {fontSize: 18, lineHeight: 24, fontWeight: '600' as const},
  body1: {fontSize: 16, lineHeight: 24, fontWeight: '400' as const},
  body2: {fontSize: 16, lineHeight: 24, fontWeight: '600' as const},
  body3: {fontSize: 14, lineHeight: 20, fontWeight: '400' as const},
  body4: {fontSize: 14, lineHeight: 20, fontWeight: '600' as const},
  caption: {fontSize: 12, lineHeight: 16, fontWeight: '400' as const},
  button: {fontSize: 16, lineHeight: 24, fontWeight: '600' as const},
} as const;

/** Flat-by-default cards; subtle elevation only when surface needs to lift. */
export const shadow = {
  none: {},
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: {width: 0, height: 2},
    elevation: 2,
  },
  overlay: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: {width: 0, height: 8},
    elevation: 8,
  },
} as const;
