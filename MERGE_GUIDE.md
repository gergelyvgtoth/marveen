# Merge Strategy Guide

This document describes how to maintain the fork and synchronize with the upstream repository.

## Overview

The `gergelyvgtoth/marveen` fork contains fork-specific files that should not be overwritten during upstream updates:
- `scripts/watchdog.sh` — local monitoring script
- `agents/*/agent-config.json` — agent configurations (local setup)

The `.gitattributes` file is configured to use the `merge=ours` strategy for these files, meaning our local versions are always preserved during merge conflicts.

## Updating from Upstream

To sync with the latest changes from `Szotasz/marveen`:

```bash
git fetch upstream
git merge upstream/main
```

The merge driver will automatically preserve fork-specific files. If there are unrelated conflicts, resolve them manually.

## After Merge

1. **Test the merge**: Run `scripts/start-all.sh` or relevant integration tests to ensure the merge didn't break anything.
2. **Push to fork**: `git push origin gergely-dev`
3. **Create PR if needed**: If you want to contribute changes back to upstream, create a PR from your branch.

## Important Notes

- Do **not** force-push to `upstream` (`Szotasz/marveen`). Only work on the fork (`gergelyvgtoth/marveen`).
- The `merge=ours` strategy only applies to the listed files. Other conflicting files must be resolved manually.
- If `agent-config.json` changes in upstream, you may need to manually review and cherry-pick important updates.

## Troubleshooting

**Conflict in a file not listed in `.gitattributes`?**
Use `git diff` to review changes and decide which version to keep.

**Need to revert a merge?**
```bash
git merge --abort  # before committing
git reset --hard HEAD~1  # after committing
```

**Push conflict to fork?**
Ensure `origin` points to `gergelyvgtoth/marveen`:
```bash
git remote -v  # check remotes
git push origin gergely-dev  # push to fork
```
