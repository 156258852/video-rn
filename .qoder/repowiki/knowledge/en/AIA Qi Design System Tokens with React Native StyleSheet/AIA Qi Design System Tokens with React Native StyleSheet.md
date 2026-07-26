---
kind: frontend_style
name: AIA Qi Design System Tokens with React Native StyleSheet
category: frontend_style
scope:
    - '**'
source_files:
    - theme/qi.ts
    - App.tsx
---

The project implements its frontend style through the AIA Qi Design System, a React Native–specific token layer that centralizes colors, spacing, typography, radius, and shadows. All visual styling is applied via React Native's `StyleSheet.create` rather than CSS-in-JS libraries or external stylesheets.

**Design tokens** are defined in `theme/qi.ts`, which exports typed constants for:
- `colors`: brand (red, navy), surface (page, default, alternate), text (default, subdued, disabled, inverse, link), border (subtle, focus), and status (success, warning, error)
- `spacing`: a 4px base grid with named increments (s4, s8, s12, s16, s24, s32, s40, s80)
- `radius`: sm (4), md (8), lg (16), pill (999)
- `typography`: a full type scale from h1 through caption and button, each with fontSize, lineHeight, and fontWeight
- `shadow`: flat-by-default with optional card and overlay elevation using native shadow properties

These tokens are consumed directly in `App.tsx`'s `StyleSheet.create` block — every color, spacing value, radius, and typography rule references the corresponding token export. The file also contains inline style objects for video controls and fullscreen overlays that follow the same token conventions.

**Styling approach**: The codebase uses React Native's built-in `StyleSheet` API exclusively. There are no CSS files, SCSS, Tailwind, or CSS-in-JS libraries (except a legacy `HtmlRenderer` component in `Componment/HtmlRendet.js` that renders raw HTML via `dangerouslySetInnerHTML` and uses `classnames` — this appears to be an unused utility). Fonts fall back to iOS system fonts; the token comments note how to bundle Montserrat/Open Sans later via `react-native-asset`. Dark theme tokens are explicitly omitted in favor of light-theme parity with the mockup.

**Conventions observed**:
- Spacing always uses the `spacing.sN` tokens (no arbitrary pixel values for layout gaps)
- Colors are sourced from the `colors.*` namespace (no hardcoded hex literals except for temporary placeholders like hero backgrounds)
- Typography is applied by spreading `typography.*` objects into style blocks
- Shadows use the `shadow.*` tokens rather than ad-hoc shadow definitions
- Components are styled inline within the same file via `StyleSheet.create`, keeping styles co-located with components

No separate design-system package or theming provider is used; tokens are imported directly where needed.