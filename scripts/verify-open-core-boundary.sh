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

FORBIDDEN_EURC_ADDRESSES=(
  '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42'
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42'
)

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

for p in "${FORBIDDEN_PATTERNS[@]}"; do check_pattern "$p"; done
for a in "${FORBIDDEN_EURC_ADDRESSES[@]}"; do check_pattern "$a"; done

if [ "${VIOLATIONS}" -eq 0 ]; then ok "paybot-sdk boundary clean."; exit 0; fi
fail "paybot-sdk boundary VIOLATED. ${VIOLATIONS} violation(s)."
exit 1
