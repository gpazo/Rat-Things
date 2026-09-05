# Architecture social demo

An approximately one-minute, captioned square video of the actual Three.js
explorer. It shows the assembled and exploded stack, all eight subsystems, an
illustrated webhook request path, and source evidence. Slow auto-rotation uses the
website's own control. No AWS resources or agent runs are started.

## Re-create the video

Install the repository dependencies, FFmpeg (with `libx264`) and the test browser:

```sh
npm ci
npx playwright install chromium
npm run demo:architecture
```

The command builds the current site, starts a temporary server on
`127.0.0.1:4175`, records an independent browser, then closes both. Port 4175 must
be free. It does not navigate the user's browser or publish anything.

Outputs, overwritten on each successful export:

- `assets/rat-things-architecture-demo.mp4`: 1080 × 1080, 30 fps, H.264 with
  silent AAC audio, captions burned into the picture.
- `assets/rat-things-architecture-demo-poster.jpg`: an opening-frame thumbnail.
- `assets/rat-things-architecture-demo-evidence.json`: duration, dimensions,
  file size, chapter timings and source provenance.

Raw footage, caption images, chapter screenshots and intermediate clips stay in
the ignored `test-results/architecture-demo/` directory. To re-export completed
footage without recording again, run `npm run demo:architecture -- --export-only`.
This uses the existing caption PNGs; re-record after changing the storyboard.

## Evolve the sequence

Edit `storyboard.json` for chapter titles, captions and lengths. Keep text within
the layout's two-line caption area; rendering fails if a caption overflows.
`recorder.mjs` owns the interactions and asset selections. `export.mjs` owns
framing, fades, encoding and output checks. Change the fixed chapter checks and
timing colors together if adding or removing chapters.

The capture interacts with real controls and verifies selected resources,
rotation state, full explosion, completed walkthrough and browser errors. A
colored timing slate sits outside the exported crop, allowing idle/loading gaps
to be removed without estimating wall-clock timing. The final wide shot covers
the slate. Some interaction sequences are sped up to fit the storyboard.

The export validates the codec, resolution, frame rate, audio, duration and file
size against the expected [X upload profile](https://help.x.com/en/using-x/x-videos).
The current edit is below the standard account's 140-second and 512 MB limits.
Review the resulting video visually after changing the UI: captions, resource
framing, rotation, transitions and the source-code outro. The request walkthrough
illustrates architecture; it does not claim a live deployment ran successfully.
