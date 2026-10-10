# Native UI conventions

egui redraws the interface each frame; redrawing must not reset application state.

- Keep network and filesystem work in the background worker. Submit requests on
  explicit actions or guarded polling deadlines, never unconditionally per frame.
- Treat navigation and refresh as different operations. Navigation may clear the
  previous resource; refresh retains the last successful data, drafts, scroll,
  open controls and render caches until new data arrives. Reselecting the current
  resource or section is a no-op.
- Use the shared loading feedback delay for pending requests. Fast requests need
  no spinner. Slow requests get local feedback; never replace usable content with
  a loading screen. Preserve usable data on errors and offer retry.
- Keep resource identity separate from request identity. Check response generation
  before applying results so late responses cannot replace a newer selection.
- Use stable resource IDs for repeated widget state, not display titles or row
  positions. Avoid recreating caches or resetting widget state during refresh.
- Keep session settings in Details and setup resources in Workspace navigation.
  Give ongoing work one status location. Bound composer growth so Send/Steer stays visible.
- Session indexing must include later pages for search and pins. Refresh must keep
  existing rows until the replacement index finishes. Keep stable IDs after pinning,
  renaming or filtering, and preserve unrelated metadata when changing these fields.
- Validate async transitions with held fixture responses, including the first
  pending frame, slow responses, failures, recovery and navigation during a request.
  A screenshot taken only after completion cannot catch loading flashes.

Run `npm run console:check` for native changes, in addition to repository checks.
