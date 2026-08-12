# Card Magic Camera

A single-page, no-build website that turns your webcam into a simple card
"magic trick": start the camera, hold up a playing card, and when it's
detected the page overlays a different (randomly drawn) card on top of it
for about 3 seconds before returning to your normal camera view.

Everything runs client-side in the browser (via [OpenCV.js](https://docs.opencv.org/)
for the rectangle/edge detection) — no server, no uploads, no build step.

## Files

- `index.html` — page structure and controls
- `style.css` — styling
- `script.js` — camera handling, card detection, and the reveal effect

## Running locally

Just open `index.html` in a modern browser (Chrome/Edge/Firefox), or serve
the folder with any static file server, e.g.:

```sh
python3 -m http.server 8000
```

then visit `http://localhost:8000`. A secure context (`https://` or
`localhost`) is required for camera access.

## Publishing with GitHub Pages

1. Merge this branch into your default branch (e.g. `main`).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch".
4. Choose the branch (e.g. `main`) and folder `/ (root)`, then save.
5. GitHub will give you a URL like `https://<user>.github.io/<repo>/` —
   open it and click "Start Camera".

## How detection works

The page draws each video frame onto a small hidden canvas and runs edge
detection + contour finding (OpenCV.js) to look for a rectangle with a
playing-card-like aspect ratio (~1.4:1). When a matching rectangle is
detected consistently for a short moment, the effect triggers: a randomly
chosen card is drawn on top of it for ~3 seconds, then the view reverts to
the plain camera feed and scanning resumes.

Detection quality depends a lot on lighting and background — a card held
flat, well lit, and against a plain contrasting background works best. If
auto-detection isn't cooperating, use the "Trigger Effect (demo)" button to
preview the reveal animation on demand.
