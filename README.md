# Plotline

Graph it. Slide it. Understand it. A function grapher for the browser with animated sliders and one-tap calculus.

[![Live demo](https://img.shields.io/badge/Live_demo-lz--plotline.pages.dev-0A6CDF?style=for-the-badge)](https://lz-plotline.pages.dev/)

Mirror: https://lazarzec18.github.io/plotline/

![Plotline](screenshot.png)

## Features

**Functions**
- Up to five functions, each with its own colour, show or hide, delete with undo, and drag (or arrow key) reordering.
- Write maths the way you would on paper: `3x^2 - 2x`, `sin 2x`, `2(x + 1)`, `|x|`, `sqrt(x)`, `pi`, `e`. A leading `y =` or `f(x) =` is fine.
- Errors appear as you type, say what is wrong and where ("Missing closing bracket after "sin(x""), and underline the exact characters.
- An insert row for sin, cos, tan, ln, log, √, π, e, |x| and powers, so phones need no symbol hunting.

**Sliders**
- Any free letter other than x and e (a, b, k, m…) gets a slider automatically, shared by every function that uses it.
- Value, min, max and step are editable. Play sweeps the value back and forth at 60 fps while the graph, markers, calculus and table update live.

**The graph**
- Anti-aliased canvas at the device pixel ratio, hairline minor grid, 1-2-5 tick steps, axis labels.
- Drag to pan, wheel or pinch to zoom, arrow keys and + − when focused, animated zoom and reset.
- Roots, turning points and intersections are marked; hover or tap one for its coordinates.
- Optional dashed derivative curves and a trace readout of x, f(x) and slope for every function.
- Asymptotes (tan x, 1/x) are left as gaps, never joined by vertical lines.

**Calculus panel**
- f(a), f′(a) and the tangent line at any point, with a slider that walks the point across the view.
- Definite integral over [from, to] with shading. Bounds accept expressions like `pi/2`.
- Roots, turning points and intersections as a tappable list that pans the graph to each one.

**Table, sharing and export**
- Table of values with start, step and rows, and Copy as CSV.
- Copy link encodes functions, colours, slider values, view and overlays in the URL.
- Export PNG renders the graph at 2× with a legend of every function and slider value.
- Eight examples, from "Damped wave" to "Parameter family a·sin(bx)", each with a live preview and undo.
- Everything is saved on your device and survives a reload.

## How it works

Expressions go through a hand-written tokenizer and recursive-descent parser that builds a tree and compiles it into plain JavaScript closures. Nothing is passed to `eval`. Unknown single letters become parameter nodes that read from one shared, mutable values object, so moving a slider never recompiles anything: the next frame simply reads the new value. Parse errors carry a start and end offset, which the input uses to underline the bad characters in a mirror layer behind the text.

Curves are sampled every 0.75 px. When two neighbouring samples jump by more than a few pixels, the interval is bisected; if the jump does not shrink as the gap closes, it is a real discontinuity and the pen lifts. Roots come from sign changes refined by bisection, with asymptote flips rejected; turning points are roots of a central-difference derivative; intersections are roots of f − g where both are defined. Integrals use composite Simpson's rule with 4,000 intervals.

A single requestAnimationFrame loop advances playing sliders and view animations, throttles the heavier work (key points, table) while things are moving, and redraws. The same scene renderer draws the live canvas and the 2× export.

## Tech

- HTML, CSS and JavaScript. No framework, no build step.
- Canvas 2D for the graph, inline SVG for previews.
- Zec Labs kit (`zl.css`, `zl.js`) for layout, components, toasts, tour and storage.
- Geist from Google Fonts.

## Run locally

```
python3 -m http.server
```

Then open http://localhost:8000.

## Project structure

| File | What it does |
| --- | --- |
| `index.html` | Page: hero, the grapher, how it works, features, FAQ |
| `parser.js` | Tokenizer, parser, compiler, calculus helpers, URL state |
| `plot.js` | Scene renderer for canvas and PNG export, SVG previews |
| `app.js` | State, persistence, UI, sliders, panels, interactions, tour |
| `styles.css` | App styles on top of the kit |
| `zl.css`, `zl.js` | Shared Zec Labs kit (unchanged) |
| `_headers` | Cloudflare Pages headers |

## Testing

A Python Playwright suite (155 checks) drives the real UI in Chromium:

- Parser: 22 evaluation cases, 8 error cases, error ranges, parameter detection, no `eval`.
- Sliders: `a*sin(b*x)` creates a and b, new letters get defaults, changing a slider changes f(a) and the plotted pixels, range edits, inline range errors, play and pause.
- Errors: inline messages, highlighted characters, status flag.
- Calculus: roots and turning points, f(a), f′(a), tangent equation, integrals with expression bounds, tap to centre.
- Intersections of x² and x + 2 at (−1, 1) and (2, 4).
- Table: CSV values on the clipboard, clean decimals, inline errors.
- Functions: five-function limit, delete and undo, hide, keyboard and drag reorder, colours, insert keys.
- Graph: trace, derivative, asymptote gaps checked by pixel, zoom, pan, wheel, reset, keyboard pan.
- Export PNG is a real 2× PNG with content; copy link and URL round trip including slider values; persistence across reload.
- Guided tour (6 steps), dark theme, no console errors, and at 390 px: no horizontal scroll, 44 px targets, 16 px inputs, pinch zoom, touch trace.

---

Part of Zec Labs, a set of small, polished web apps by [Lazar Zec](https://github.com/LAZARZEC18). See them all at https://lazarzec.pages.dev/
