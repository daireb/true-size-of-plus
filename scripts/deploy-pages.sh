#!/bin/sh
# Build for GitHub Pages and force-push the output to the gh-pages branch.
# The gh-pages branch holds only build output and is rewritten every deploy;
# nothing but this script should ever commit to it.
set -e
REMOTE=$(git remote get-url origin)
GHPAGES=1 npm run build
cd dist
rm -rf .git
git init -q
git checkout -qb gh-pages
git add -A
git commit -qm "deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -f "$REMOTE" gh-pages
rm -rf .git
echo "deployed."
