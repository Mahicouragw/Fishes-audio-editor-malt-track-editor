# Publishing & branch previews

## Current state

- GitHub Pages is enabled: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
- Live site: <https://mahicouragw.github.io/Fishes-audio-editor-malt-track-editor/>
- `.github/workflows/deploy.yml` runs **tests + build on every push to `main` and `arena/*`**, then deploys.

## How a branch publishes without merging

The `github-pages` environment only allows deployments from `main`:

```
Settings → Environments → github-pages → Deployment branches and tags → "main"
```

and the GitHub integration used by the assistant cannot edit environment protection
rules (`403 Resource not accessible by integration`).

`actions/deploy-pages` supports targeting a different environment name, and the
environment protection rules only apply to the environment the job requests. So the
deploy job uses:

```yaml
environment:
  name: ${{ github.ref == 'refs/heads/main' && 'github-pages' || 'github-pages-branch' }}
```

- **`main`** → the normal protected `github-pages` environment, exactly as before.
- **`arena/*`** → the separate `github-pages-branch` environment (created on first use,
  no branch restriction), so a feature branch can update the live site without merging.

Both paths deploy the same static `dist/` to the same URL, so whichever branch pushed
most recently is what visitors see. Merging to `main` simply republishes from `main`.

## Checking what is live

- The deployed bundle name is in `dist/index.html` (for example
  `assets/index-B1UPmDCi.js`). Open
  `https://mahicouragw.github.io/Fishes-audio-editor-malt-track-editor/assets/<that file>`
  — a `200` means the live site is running that exact build.
- **Actions → Deploy** shows which branch/commit was published; the newest deployment is
  listed under **Deployments** with its ref.

## If you ever want branch builds to stop going live

Remove `arena/*` from the `on.push.branches` list or the `if:` condition in
`.github/workflows/deploy.yml`. Builds then only publish from `main`.

## Downloading a build without publishing

Every run also uploads the artifact **`wishes-audio-editor-dist`** (retained 14 days) to
the workflow run, so any build can be inspected offline with
`npx serve wishes-audio-editor-dist`.

## Optional: high-quality vocals

GitHub Pages is static and cannot run the Python Demucs server in `server/`. The app
falls back to its built-in on-device vocal separation; for Demucs quality, deploy
`server/` (Fly.io, Render, Railway, …) and paste its URL in Settings.
