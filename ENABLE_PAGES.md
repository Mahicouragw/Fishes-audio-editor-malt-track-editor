# ✅ Enable GitHub Pages — Click These Links

### 1) Merge the app to `main` (so Pages can publish it)

Your studio code is on branch `arena/72a74c9c-fishes-audio-editor-malt-track` and already has a PR.

👉 **Click to merge:**
- **PR #1:** https://github.com/Mahicouragw/Fishes-audio-editor-malt-track-editor/pull/1

Or manually:
1. Open https://github.com/Mahicouragw/Fishes-audio-editor-malt-track-editor/pull/1
2. Click **Merge pull request** → **Confirm merge**

### 2) Turn on GitHub Pages (builds via GitHub Actions)

After merging, enable Pages:

👉 **Pages Settings:**
https://github.com/Mahicouragw/Fishes-audio-editor-malt-track-editor/settings/pages

Then:
1. Under **Build and deployment** → **Source**, select **GitHub Actions** (NOT `Deploy from a branch`)
2. Save

The workflow `.github/workflows/deploy.yml` will then run automatically on every push to `main`.

👉 **See it building:**
https://github.com/Mahicouragw/Fishes-audio-editor-malt-track-editor/actions

When the green check appears, your site will be live at:

👉 **Your live site (after Pages is enabled):**
- `https://mahicouragw.github.io/Fishes-audio-editor-malt-track-editor/`
- (GitHub also shows the exact URL at the top of the Pages settings page and in Actions → Deploy → `page_url`)

### 3) Want instant preview without merging? (optional)

You can also deploy from the arena branch for testing:

👉 **Actions → Run workflow manually:**
https://github.com/Mahicouragw/Fishes-audio-editor-malt-track-editor/actions/workflows/deploy.yml

Click **Run workflow** → choose `arena/72a74c9c-fishes-audio-editor-malt-track` → **Run workflow**
> Note: the workflow on this repo only **publishes** when `github.ref == main`, but it still **builds & tests** on arena branches so you can verify.

If you want it to publish from arena immediately, change in `.github/workflows/deploy.yml`:

```yaml
if: github.ref == 'refs/heads/main'
# to:
if: true   # or add branches: [arena/*] to the deploy job
```

### 4) Need help?

- **Repo:** https://github.com/Mahicouragw/Fishes-audio-editor-malt-track-editor
- **Server docs:** https://github.com/Mahicouragw/Fishes-audio-editor-malt-track-editor/tree/arena/72a74c9c-fishes-audio-editor-malt-track/server#readme
- **Local dev:** `npm install && npm run dev` → http://localhost:5173

> First deploy takes 1–2 minutes. If you see 404, wait for Actions to finish and hard-refresh.
