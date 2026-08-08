#!/bin/sh
# Build for GitHub Pages and force-push the output to the gh-pages branch.
set -e
REMOTE=$(git remote get-url origin)
GHPAGES=1 npm run build
cd dist
rm -rf .git
git init -q
git checkout -qb gh-pages
git add -A
git -c user.name="daireb" -c user.email="bohan.daire@gmail.com" commit -qm "deploy"
git push -f "$REMOTE" gh-pages
rm -rf .git
echo "deployed."
