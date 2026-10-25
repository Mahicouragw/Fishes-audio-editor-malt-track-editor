# Publishing & branch previews

## Current state

- GitHub Pages is enabled with **Build and deployment → Source: GitHub Actions**.
- `.github/workflows/deploy.yml` runs **tests + build on every push to `main` and `arena/*`**.
- Publishing is intentionally limited to `main` (see below).

## Why the branch build does not publish to Pages by itself

Publishing to Pages goes through the `github-pages` *environment*. In this repository that
environment uses a custom deployment-branch policy that currently allows **only `main`**:

```
Settings → Environments → github-pages → Deployment branches and tags → "main"
```

The GitHub connection used by the assistant cannot change environment protection rules
(the API returns `403 Resource not accessible by integration`), so a push from
`arena/*` builds and tests but cannot publish.

## Option A — verify the branch build without publishing

1. Open **Actions** → the latest **Deploy** run for the branch.
2. Download the artifact **`wishes-audio-editor-dist`** (retained 14 days).
3. Serve it locally with any static server, e.g. `npx serve wishes-audio-editor-dist`.

## Option B — publish straight from the branch (one-time switch)

1. Open https://github.com/Mahicouragw/Fishes-audio-editor-malt-track-editor/settings/environments
2. Open the **github-pages** environment → **Deployment branches and tags**.
3. Add a policy: **Branch → `arena/eebbbf45-fishes-audio-editor-malt-track`** (or a pattern `arena/*`).
4. Uncomment the branch condition in `.github/workflows/deploy.yml`:

```yaml
  deploy:
    needs: build
    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/arena/')
```

After that, the next push from the branch publishes to
`https://mahicouragw.github.io/Fishes-audio-editor-malt-track-editor/` and replaces the
`main` build until you merge (then a `main` push republishes `main`).

## Option C — merge (normal flow)

Merging the pull request into `main` publishes automatically. Until you say merge, the
branch is kept unmerged on purpose.

## Live development preview

While the sandbox session is open, the app runs there with hot reload; that preview
serves this branch directly and needs no publishing step.
