#!/usr/bin/env bash
# Cloud-compatible bootstrap that installs the fleet coordination CLIs (`board` for
# Linear, `agent-sync` for Zulip) into ~/.local/bin for fresh Claude/Cursor Linux
# setups. Both CLIs live in Simple-With-Us/ai-fleet-coordinator under scripts/.
# The canonical Mac installer is AFC scripts/agent_sync/install.sh, but it expects
# an AFC checkout that does not exist on a fresh Linux cloud VM. This installer
# fetches the minimal `scripts/` subset via curl from GitHub's archive endpoint,
# then symlinks both CLIs into ~/.local/bin.
#
# Idempotent (re-runs are no-ops when the pinned SHA matches and both links exist).
# Soft-fails on network or git errors with a warning and exit 0, never a hard fail;
# the calling cloud setup must keep going. Per AGENTS.md, a cloud seat with no CLI
# still posts Linear/Zulip via plain curl+GraphQL per
# ai-fleet-coordinator/docs/protocols/zulip-fleet-guide.md Core Actions.
#
# Pinned AFC SHA. Bump when AFC rewrites the entry point or the install contract.
set -uo pipefail

AFC_REPO="${AFC_REPO:-https://github.com/Simple-With-Us/ai-fleet-coordinator}"
AFC_SHA="${AFC_SHA:-1c39b0dcaeb846c68648c2b34764a1a7a0268c37}"
CACHE_DIR="${FLEET_COORD_CACHE:-$HOME/.cache/ai-fleet-coordinator}"
BIN_DIR="$HOME/.local/bin"
LINK_BOARD="$BIN_DIR/board"
LINK_AGENT_SYNC="$BIN_DIR/agent-sync"
SHA_FILE="$CACHE_DIR/.pinned-sha"

log()  { printf '[fleet-coordination] %s\n' "$*"; }
warn() { printf '[fleet-coordination] WARN: %s\n' "$*" >&2; }

# Skip on macOS. The Mac lane has /Users/jay/apps/AGENT-SYNC.md and the canonical
# AFC checkout at /Users/jay/apps/lanes/_managed/fleet/agent-sync-runtime; AFC's
# install.sh handles it. This script is the Linux/cloud fallback only.
if [[ "$(uname -s)" == "Darwin" ]]; then
  log "macOS detected; the Mac lane has its own AFC checkout. Skipping."
  exit 0
fi

# Idempotency: if both links already point at the cached checkout and the SHA matches,
# skip the fetch.
existing_sha=""
[[ -s "$SHA_FILE" ]] && existing_sha="$(cat "$SHA_FILE" 2>/dev/null || true)"
have_link() {
  local link="$1"
  [[ -L "$link" ]] || return 1
  local target; target="$(readlink "$link" 2>/dev/null)" || return 1
  [[ -e "$target" ]]
}
if [[ "$existing_sha" == "$AFC_SHA" ]] && have_link "$LINK_BOARD" && have_link "$LINK_AGENT_SYNC"; then
  log "already installed at pinned SHA ${AFC_SHA:0:7}; nothing to do."
  exit 0
fi

# Need curl to fetch from GitHub's archive endpoint. tar with --strip-components is
# in GNU tar and BSD tar since Leopard; both Linux and macOS hosts have one.
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  warn "curl or tar missing; cannot install board/agent-sync."
  warn "Cloud seats can still post via curl+GraphQL per docs/protocols/zulip-fleet-guide.md Core Actions."
  exit 0
fi

mkdir -p "$CACHE_DIR"

# Fetch the scripts/ subtree via GitHub's archive endpoint, then strip the
# repo-<sha>/ prefix so the cache holds only scripts/. The pinned SHA guarantees
# reproducibility across cloud sessions.
log "fetching fleet coordination CLIs from AFC @ ${AFC_SHA:0:7}"
archive_url="$AFC_REPO/archive/$AFC_SHA.tar.gz"
tmp_tar="$(mktemp "${TMPDIR:-/tmp}/fleet-coordination.XXXXXX.tar.gz")"
if ! curl -fsSL --retry 2 --connect-timeout 10 --max-time 120 \
       -o "$tmp_tar" "$archive_url"; then
  rm -f "$tmp_tar"
  warn "AFC archive fetch failed (network or rate limit); skipping."
  warn "Cloud seats can still post via curl+GraphQL per docs/protocols/zulip-fleet-guide.md Core Actions."
  exit 0
fi
# Detect the top-level prefix the archive uses (e.g. "AI-Fleet-Coordinator-<sha>/").
# GitHub's codeload endpoint renders the repo name case-preserved, so do not assume.
afc_prefix="$(tar -tzf "$tmp_tar" 2>/dev/null | awk -F/ 'NR==1{print $1; exit}')"
if [[ -z "$afc_prefix" ]]; then
  rm -f "$tmp_tar"
  warn "AFC archive appears empty; skipping."
  exit 0
fi
if ! tar -xz -C "$CACHE_DIR" --strip-components=1 \
       -f "$tmp_tar" "$afc_prefix/scripts"; then
  rm -f "$tmp_tar"
  warn "AFC archive extract failed (path mismatch or corrupt tar); skipping."
  exit 0
fi
rm -f "$tmp_tar"
printf '%s\n' "$AFC_SHA" > "$SHA_FILE"

# Symlink the CLIs into ~/.local/bin. Idempotent; never overwrite a foreign non-symlink.
mkdir -p "$BIN_DIR"
install_link() {
  local src="$1" link="$2"
  if [[ ! -e "$src" ]]; then
    warn "$src missing after fetch; not linking $link."
    return 0
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
    return 0
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

log "installed. Verify with: $LINK_AGENT_SYNC --help   $LINK_BOARD whoami"
exit 0