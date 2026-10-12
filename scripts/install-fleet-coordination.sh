#!/usr/bin/env bash
# Install pinned, stdlib-only fleet coordination CLIs for Linux cloud sessions.
# Also fetch their registry and protocol documents, and retire persisted Slack hooks.
# Failures return nonzero: product setup may continue, but fleet work must stop until
# the CLIs and their separately provisioned runtime credentials pass identity checks.
# No secrets, daemons, listeners, or model sessions are provisioned by this helper.
set -euo pipefail

AFC_REPO="${AFC_REPO:-https://github.com/Simple-With-Us/ai-fleet-coordinator}"
AFC_SHA="${AFC_SHA:-1c39b0dcaeb846c68648c2b34764a1a7a0268c37}"
CACHE_DIR="${FLEET_COORD_CACHE:-$HOME/.cache/ai-fleet-coordinator}"
BIN_DIR="${FLEET_COORD_BIN:-$HOME/.local/bin}"
LINK_BOARD="$BIN_DIR/board"
LINK_AGENT_SYNC="$BIN_DIR/agent-sync"
SHA_FILE="$CACHE_DIR/.pinned-sha"

log()  { printf '[fleet-coordination] %s\n' "$*"; }
warn() { printf '[fleet-coordination] WARN: %s\n' "$*" >&2; }

# Remove retired Slack hook entries on every platform, including reused Macs that
# already have managed fleet tooling but still carry persisted SessionStart entries
# and the copied engine from a prior setup-slack-sync.sh run.
# No credentials are read, and unrelated settings stay intact.
bash "$(dirname "$0")/setup-slack-sync.sh"

# The Mac already has managed fleet tooling.  Only cloud/Linux setup runs here.
if [[ "$(uname -s)" == "Darwin" ]]; then
  log "macOS detected; the Mac lane has its own AFC checkout.  Skipping."
  exit 0
fi

if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then
  warn "Python 3.11 or newer is required; fleet coordination is unavailable."
  exit 1
fi

# Idempotency: if both links already point at the cached checkout and the SHA matches,
# skip the fetch.
existing_sha=""
[[ -s "$SHA_FILE" ]] && existing_sha="$(cat "$SHA_FILE" 2>/dev/null || true)"
have_link() {
  local link="$1" expected="$2"
  [[ -L "$link" ]] || return 1
  local target; target="$(readlink "$link" 2>/dev/null)" || return 1
  [[ "$target" == "$expected" ]] && [[ -f "$target" ]]
}
if [[ "$existing_sha" == "$AFC_SHA" ]] && have_link "$LINK_BOARD" "$CACHE_DIR/scripts/linear-board/board" && have_link "$LINK_AGENT_SYNC" "$CACHE_DIR/scripts/agent-sync" && [[ -f "$CACHE_DIR/AGENT-SYNC.md" && -f "$CACHE_DIR/fleet-apps.json" && -f "$CACHE_DIR/docs/protocols/zulip-fleet-guide.md" ]]; then
  log "already installed at pinned SHA ${AFC_SHA:0:7}; nothing to do."
  exit 0
fi

# Need curl to fetch from GitHub's archive endpoint.  tar with --strip-components is
# in GNU tar and BSD tar since Leopard; both Linux and macOS hosts have one.
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  warn "curl or tar missing; cannot install board/agent-sync."
  warn "Do not perform fleet work until installation and identity checks succeed."
  exit 1
fi

mkdir -p "$CACHE_DIR"

# Fetch the scripts/ subtree via GitHub's archive endpoint, then strip the
# repo-<sha>/ prefix so the cache holds the CLIs, registry, and protocol.  The pin ensures
# reproducibility across cloud sessions.
log "fetching fleet coordination CLIs from AFC @ ${AFC_SHA:0:7}"
archive_url="$AFC_REPO/archive/$AFC_SHA.tar.gz"
tmp_tar="$(mktemp "${TMPDIR:-/tmp}/fleet-coordination.XXXXXX.tar.gz")"
if ! curl -fsSL --retry 2 --connect-timeout 10 --max-time 120 \
       -o "$tmp_tar" "$archive_url"; then
  rm -f "$tmp_tar"
  warn "AFC archive fetch failed (network or rate limit); skipping."
  warn "Do not perform fleet work until installation and identity checks succeed."
  exit 1
fi
# Detect the top-level prefix the archive uses (e.g. "AI-Fleet-Coordinator-<sha>/").
# GitHub's codeload endpoint renders the repo name case-preserved, so do not assume.
afc_prefix="$(tar -tzf "$tmp_tar" 2>/dev/null | awk -F/ 'NR==1{print $1}')"
if [[ -z "$afc_prefix" ]]; then
  rm -f "$tmp_tar"
  warn "AFC archive appears empty; installation failed."
  exit 1
fi

# Extract into a fresh temporary directory so a partial or advancing pin never
# leaves a mixed tree in $CACHE_DIR: files removed or relocated by the new
# revision cannot survive alongside the old ones, and an interrupted run
# cannot damage the live install.
tmp_extract="$(mktemp -d "${CACHE_DIR}.stage.XXXXXX")"
trap 'rm -rf "$tmp_extract"' EXIT
if ! tar -xz -C "$tmp_extract" --strip-components=1 \
       -f "$tmp_tar" "$afc_prefix/scripts" "$afc_prefix/AGENT-SYNC.md" \
       "$afc_prefix/fleet-apps.json" "$afc_prefix/docs/protocols"; then
  rm -rf "$tmp_extract" "$tmp_tar"
  warn "AFC archive extract failed (path mismatch or corrupt tar)."
  exit 1
fi
rm -f "$tmp_tar"

for required in scripts/linear-board/board scripts/agent-sync AGENT-SYNC.md fleet-apps.json docs/protocols/zulip-fleet-guide.md; do
  if [[ ! -e "$tmp_extract/$required" ]]; then
    rm -rf "$tmp_extract"
    warn "AFC archive missing required path: $required"
    exit 1
  fi
done

# Validate the new tree before replacing a working installation.  These offline
# argument-parser checks exercise imports without reading runtime credentials.
for cli in scripts/linear-board/board scripts/agent-sync; do
  chmod +x "$tmp_extract/$cli"
  if ! "$tmp_extract/$cli" --help >/dev/null; then
    warn "AFC CLI validation failed; the previous cache remains unchanged."
    exit 1
  fi
done

# Replace the tree using same-filesystem renames.  The two renames are not an
# atomic transaction; retain the old tree for recovery until promotion succeeds.
stale_cache=""
if [[ -d "$CACHE_DIR" ]]; then
  stale_cache="$CACHE_DIR.old.$$"
  if ! mv "$CACHE_DIR" "$stale_cache"; then
    rm -rf "$tmp_extract"
    warn "AFC cache swap failed (rename out); cache left unchanged."
    exit 1
  fi
fi
if ! mv "$tmp_extract" "$CACHE_DIR"; then
  if [[ -n "$stale_cache" ]] && [[ -e "$stale_cache" ]]; then
    mv "$stale_cache" "$CACHE_DIR" || warn "AFC cache restore failed; manual recovery from $stale_cache required."
  fi
  rm -rf "$tmp_extract"
  warn "AFC cache swap failed (rename in); cache left unchanged."
  exit 1
fi
if [[ -n "$stale_cache" ]]; then
  rm -rf "$stale_cache"
fi

# Symlink the CLIs into ~/.local/bin.  Idempotent; never overwrite a foreign non-symlink.
mkdir -p "$BIN_DIR"
install_link() {
  local src="$1" link="$2"
  if [[ ! -e "$src" ]]; then
    warn "$src missing after fetch; not linking $link."
    return 1
  fi
  [[ -x "$src" ]] || chmod +x "$src" 2>/dev/null || true
  if [[ -L "$link" ]]; then
    local current; current="$(readlink "$link" 2>/dev/null)" || current=""
    if [[ "$current" == "$src" ]]; then
      log "$link -> $src (unchanged)"
      return 0
    fi
    ln -sfn "$src" "$link"
  elif [[ -e "$link" ]]; then
    warn "$link exists and is not a symlink; leaving alone."
    return 1
  else
    ln -s "$src" "$link"
  fi
  log "$link -> $src"
}

install_link "$CACHE_DIR/scripts/linear-board/board" "$LINK_BOARD"
install_link "$CACHE_DIR/scripts/agent-sync"         "$LINK_AGENT_SYNC"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) log "note: $BIN_DIR is not on PATH; export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# Import and argument-parser checks are offline and never read credentials.
"$LINK_AGENT_SYNC" --help >/dev/null
"$LINK_BOARD" --help >/dev/null
printf '%s\n' "$AFC_SHA" > "$SHA_FILE"
log "Installed.  Read $CACHE_DIR/AGENT-SYNC.md and verify both CLI identities before fleet work."
log "Cloud runtime needs the Fleet Linear app credentials and this seat's Zulip credentials."
log "Enable authorized Linear writes with LINEAR_BOARD_WRITES=1; never use an owner token."
exit 0
