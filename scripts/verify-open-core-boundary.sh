#!/usr/bin/env bash
# verify-open-core-boundary.sh — paybot-sdk local copy
# Mirror of paybot-mcp/scripts/verify-open-core-boundary.sh, scoped to SDK src.
# Canonical: paybot/scripts/verify-open-core-boundary.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_DIR="${REPO_ROOT}/src"

VIOLATIONS=0

FORBIDDEN_PATTERNS=(
  'MiCA' 'FIN-FSA' 'Chainalysis' 'Elliptic' 'Onfido' 'Tink' 'PSD2'
  'AML adapter' 'AML_PROVIDER' 'KYC artifact' 'KYC_ISSUER_DID'
  '/security/policy' '/security/aml' '/integrations/psd2'
)

ALLOWLIST_REGEX='(Psd2|Aml|Mica|Kyc)[A-Z][A-Za-z]*'

# SHA-256 of the lowercased operator-private EURC mainnet address (incl. 0x prefix).
# The literal address is NEVER stored here — only this one-way hash. Detection
# extracts 0x-40-hex tokens from scanned content, lowercases + hashes each, and
# compares to this hash. Functionally equivalent to a literal denylist, but the
# guarded value never appears in shippable code (the guard no longer publishes it).
FORBIDDEN_EURC_ADDR_SHA256='b263ba174b7c339735c3734a9829d0dc5af0f5dd2efbfdfe79add4065a44148a'

red()   { printf '\033[31m%s\033[0m' "$1"; }
green() { printf '\033[32m%s\033[0m' "$1"; }
fail()  { printf '%s %s\n' "$(red '[FAIL]')" "$*" >&2; }
ok()    { printf '%s %s\n' "$(green '[OK]')" "$*"; }

if [ ! -d "${SRC_DIR}" ]; then echo "[WARN] no src/ — skipping"; exit 0; fi

check_pattern() {
  local pat="$1"
  local hits
  hits="$(grep -rniF --include='*.ts' "${pat}" "${SRC_DIR}" 2>/dev/null || true)"
  [ -z "${hits}" ] && return 0
  local filtered=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local text="${line#*:*:}"
    if echo "$text" | grep -qE "${ALLOWLIST_REGEX}" \
       && ! echo "$text" | grep -qiE "(${pat}_|${pat} )"; then
      continue
    fi
    filtered+="${line}"$'\n'
  done <<< "${hits}"
  if [ -n "${filtered}" ]; then
    fail "forbidden '${pat}' in paybot-sdk/src/"
    printf '%s' "${filtered}" | sed 's/^/        /'
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
}

# Hash-based detection for the operator-private token address. Extract every
# 0x-40-hex token from src/, normalize (lowercase incl. 0x), sha256 each, and
# compare to the stored hash. The address literal never appears in this code,
# and the failure message never prints the offending value.
check_forbidden_address_hash() {
  local hits
  hits="$(grep -rnoE --include='*.ts' '0x[0-9a-fA-F]{40}' "${SRC_DIR}" 2>/dev/null || true)"
  [ -z "${hits}" ] && return 0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # line looks like: <file>:<lineno>:<token>
    local file token token_hash
    file="${line%%:*}"
    token="${line##*:}"
    token_hash="$(printf '%s' "${token,,}" | sha256sum | cut -d' ' -f1)"
    if [ "${token_hash}" = "${FORBIDDEN_EURC_ADDR_SHA256}" ]; then
      fail "operator-private token address detected in ${file}"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done <<< "${hits}"
}

for p in "${FORBIDDEN_PATTERNS[@]}"; do check_pattern "$p"; done
check_forbidden_address_hash

if [ "${VIOLATIONS}" -eq 0 ]; then ok "paybot-sdk boundary clean."; exit 0; fi
fail "paybot-sdk boundary VIOLATED. ${VIOLATIONS} violation(s)."
exit 1
