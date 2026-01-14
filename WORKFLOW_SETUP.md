# Workflow setup (if you uploaded via GitHub web UI)

If you uploaded files using “Add files via upload”, GitHub often **does not preserve folder structure**.
This project requires a workflow file at:

`.github/workflows/update-aviationweather.yml`

## Quick fix in browser (no git needed)

1. Go to your repository on GitHub.
2. Click **Add file → Create new file**
3. In the filename field, paste exactly:
   `.github/workflows/update-aviationweather.yml`
4. Copy the contents of the same file from this repo into the editor.
5. Commit to the default branch (usually `main`).

After that you should see **Actions → Update METAR/TAF** and you can click **Run workflow**.

## Required permissions

Repository **Settings → Actions → General → Workflow permissions**:
- set to **Read and write permissions**
- optionally enable “Allow GitHub Actions to create and approve pull requests” (not required here)
