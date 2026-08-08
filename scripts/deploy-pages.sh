#!/bin/sh
# Build for GitHub Pages and force-push the output to the gh-pages branch.
set -e
GHPAGES=1 npm run build
cd dist
rm -rf .git
git init -q
git checkout -qb gh-pages
git add -A
git -c user.name="daireb" -c user.email="bohan.daire@gmail.com" commit -qm "deploy"
git push -f https://github.com/daireb/true-size-of-plus.git gh-pages
rm -rf .git
echo "deployed."
