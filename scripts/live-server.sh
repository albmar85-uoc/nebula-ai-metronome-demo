#!/usr/bin/env bash
# Live-mode verification server on :3001 (Metronome sandbox + Stripe TEST), separate from the mock demo on :3000.
# Credentials come from .env.local (loaded by Next; never committed). Own build dir (.next-live) and data dir (data-live).
# METRONOME_WEBHOOK_SECRET: the real one if you have it; otherwise a local secret is generated for replaying signed payloads.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3001}"
mkdir -p data-live
# Next never overrides variables already in the environment, so a key exported in this shell (e.g. an old Stripe
# account) would silently win over .env.local. Credentials always come from .env.local unless LIVE_KEEP_ENV=1.
[ "${LIVE_KEEP_ENV:-0}" = "1" ] || unset STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY METRONOME_API_TOKEN
if [ -z "${METRONOME_WEBHOOK_SECRET:-}" ]; then
  [ -f data-live/.webhook-secret ] || (umask 077; openssl rand -hex 32 > data-live/.webhook-secret)
  METRONOME_WEBHOOK_SECRET="$(cat data-live/.webhook-secret)"
fi
[ "${SKIP_BUILD:-0}" = "1" ] || NEXT_DIST_DIR=.next-live npx next build
exec env METRONOME_LIVE=1 LIVE_TEST_SIGNUP=1 DATA_DIR=./data-live APP_URL="http://localhost:$PORT" \
  METRONOME_WEBHOOK_SECRET="$METRONOME_WEBHOOK_SECRET" NEXT_DIST_DIR=.next-live npx next start -p "$PORT"
