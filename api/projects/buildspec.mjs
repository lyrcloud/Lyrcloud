// The CodeBuild buildspec every deployment runs. It clones the source, optionally pushes a copy to the
// user's GitHub repository, installs and builds (npm, pnpm, yarn or plain static files) and leaves the
// site in _site/, which CodeBuild uploads as the build's artifacts. The publisher (index.mjs) checks
// and copies those files to the live bucket; the build itself can't write there.
//
// Inputs (environment variables): LYR_SOURCE_URL, LYR_BRANCH, LYR_PUSH_URL, LYR_PUSH_BRANCH, LYR_ROOT_DIR,
// LYR_INSTALL_COMMAND, LYR_BUILD_COMMAND, LYR_OUTPUT_DIR. Outputs: LYR_COMMIT, LYR_COMMIT_MESSAGE, LYR_FRAMEWORK.

export const BUILD_SCRIPT = String.raw`
set -eu
say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✖ %s\033[0m\n' "$*"; exit 1; }
SITE_DIR="$CODEBUILD_SRC_DIR/_site"
mkdir -p "$SITE_DIR"
git config --global advice.detachedHead false
git config --global init.defaultBranch main

say "Cloning the repository"
clone() {
  for attempt in 1 2 3 4 5; do
    if git clone --quiet "$@" "$LYR_SOURCE_URL" "$CODEBUILD_SRC_DIR/src" 2>clone.err; then return 0; fi
    rm -rf "$CODEBUILD_SRC_DIR/src"
    sed -E 's#https://[^@/]+@#https://#g' clone.err
    [ "$attempt" = 5 ] || { echo "Retrying in 6 seconds…"; sleep 6; }
  done
  fail "Couldn't clone the repository. Check the URL and that it's public (or connected through GitHub)."
}
if [ -n "${'$'}{LYR_PUSH_URL:-}" ]; then
  # A copy needs the full history to push to a new repository.
  if [ -n "${'$'}{LYR_BRANCH:-}" ]; then clone --branch "$LYR_BRANCH" --single-branch; else clone; fi
else
  if [ -n "${'$'}{LYR_BRANCH:-}" ]; then clone --depth 1 --branch "$LYR_BRANCH"; else clone --depth 1; fi
fi
cd "$CODEBUILD_SRC_DIR/src"
LYR_COMMIT="$(git rev-parse HEAD)"
LYR_COMMIT_MESSAGE="$(git log -1 --pretty=%s | cut -c1-200)"
export LYR_COMMIT LYR_COMMIT_MESSAGE
echo "Commit $LYR_COMMIT: $LYR_COMMIT_MESSAGE"

if [ -n "${'$'}{LYR_PUSH_URL:-}" ]; then
  say "Pushing a copy to your GitHub repository"
  git push --quiet "$LYR_PUSH_URL" "HEAD:refs/heads/${'$'}{LYR_PUSH_BRANCH:-main}" 2>push.err \
    || { sed -E 's#https://[^@/]+@#https://#g' push.err; fail "Couldn't push the copy to GitHub. Make sure the Lyrcloud app can access the new repository."; }
fi

if [ -n "${'$'}{LYR_ROOT_DIR:-}" ]; then
  [ -d "$LYR_ROOT_DIR" ] || fail "The root folder \"$LYR_ROOT_DIR\" isn't in the repository."
  cd "$LYR_ROOT_DIR"
fi

LYR_FRAMEWORK=static
run_script() { # npm/pnpm/yarn run <script> with the project's package manager
  case "$PM" in
    pnpm) pnpm run "$1" ;;
    yarn) yarn run "$1" ;;
    *) npm run "$1" ;;
  esac
}
if [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ]; then PM=pnpm; elif [ -f yarn.lock ]; then PM=yarn; else PM=npm; fi
  for name in next nuxt astro @sveltejs/kit gatsby vite react-scripts @angular/core vue svelte; do
    if node -e "const p=require('./package.json');process.exit({...p.dependencies,...p.devDependencies}['$name']?0:1)" 2>/dev/null; then
      LYR_FRAMEWORK="$name"; break
    fi
  done
  [ "$LYR_FRAMEWORK" = static ] && LYR_FRAMEWORK=node
  say "Installing dependencies ($PM)"
  if [ "$PM" != npm ]; then corepack enable >/dev/null 2>&1 || npm install -g "$PM" >/dev/null; fi
  if [ -n "${'$'}{LYR_INSTALL_COMMAND:-}" ]; then sh -c "$LYR_INSTALL_COMMAND"
  elif [ "$PM" = pnpm ]; then pnpm install --frozen-lockfile || pnpm install
  elif [ "$PM" = yarn ]; then yarn install --frozen-lockfile || yarn install
  elif [ -f package-lock.json ]; then npm ci || npm install
  else npm install; fi
  if [ -n "${'$'}{LYR_BUILD_COMMAND:-}" ]; then
    say "Building: $LYR_BUILD_COMMAND"
    sh -c "$LYR_BUILD_COMMAND"
  elif node -e "process.exit(require('./package.json').scripts?.build?0:1)"; then
    say "Building ($PM run build)"
    run_script build
  else
    echo "No build script; publishing the files as they are."
  fi
elif [ -n "${'$'}{LYR_BUILD_COMMAND:-}" ]; then
  say "Building: $LYR_BUILD_COMMAND"
  sh -c "$LYR_BUILD_COMMAND"
fi
export LYR_FRAMEWORK

if [ -n "${'$'}{LYR_OUTPUT_DIR:-}" ]; then
  OUT="$LYR_OUTPUT_DIR"
else
  OUT=.
  for dir in dist build out public _site .output/public; do
    if [ -f "$dir/index.html" ]; then OUT="$dir"; break; fi
  done
fi
[ -d "$OUT" ] || fail "The output folder \"$OUT\" doesn't exist after the build."
[ -f "$OUT/index.html" ] || fail "There's no index.html in \"$OUT\". Set the output folder in the project's settings."

say "Collecting the site from $OUT"
tar -C "$OUT" --exclude=.git --exclude=node_modules --exclude='.env*' -cf - . | tar -C "$SITE_DIR" -xf -
echo "$(find "$SITE_DIR" -type f | wc -l) files, $(du -sh "$SITE_DIR" | cut -f1)"
`;

export function buildspec() {
  return JSON.stringify({
    version: '0.2',
    env: { shell: 'bash', 'exported-variables': ['LYR_COMMIT', 'LYR_COMMIT_MESSAGE', 'LYR_FRAMEWORK'] },
    phases: {
      install: { 'runtime-versions': { nodejs: 22 } },
      build: { commands: [BUILD_SCRIPT] },
    },
    artifacts: { files: ['**/*'], 'base-directory': '_site', 'discard-paths': 'no' },
  });
}
