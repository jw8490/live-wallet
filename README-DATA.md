# SSA Smart Basket — data & wallet notes (v2.0)

## Market caps (real)
- `data/ecosystem.json` — hand-maintained: the 35 platforms, which company owns each one, and the
  private-company valuations (amount, date, basis, source URL).
- `scripts/update-market-caps.mjs` — no API key. For each public company:
  market cap from the Nasdaq quote API (all share classes), price + daily % change from the
  Yahoo Finance chart API. Chedraui (Smart & Final's owner, listed in Mexico) = Yahoo MXN price ×
  959.24M shares ÷ live USD/MXN. If Nasdaq fails, it falls back to Yahoo price × shares implied by the
  last good Nasdaq read; if everything fails for a ticker, the previous value is kept and flagged `stale`.
  Writes `data/market-caps.json` and refreshes the fallback snapshot embedded in `index.html`.
- `.github/workflows/update-market-caps.yml` — runs every 30 min on weekdays 13:00–21:30 UTC, daily at
  22:20 UTC, on manual dispatch, and when the config/script changes. Commits only if data changed, then
  asks GitHub Pages to rebuild.
- The page loads `data/market-caps.json` (falls back to raw.githubusercontent.com if the local copy is
  over 2h old, then to the embedded snapshot) and re-checks every 5 min.

Ecosystem Cap = Σ public market caps + Σ private last-reported valuations, **each owning company once**
(Instagram + Facebook → Meta, YouTube → Alphabet, Twitch → Amazon, Grok/Grokipedia/X/SpaceXAI → SpaceX,
ChatGPT → OpenAI, Apple Store → Apple, Smart & Final → Chedraui, Weather → The Weather Company).

To update a private valuation: edit `data/ecosystem.json`, push; the workflow regenerates the data.

## Wallet (live)
- Injected wallet (EIP-6963 / window.ethereum; MetaMask, Trust, Coinbase deep links), switches/adds BSC (56).
- Real BNB + BEP-20 balances via public BSC RPCs (fallback list), refreshed every 15s and on
  `accountsChanged` / `chainChanged`. Token facts (name, symbol, decimals, supply, owner, paused) read
  from the contract.
- Token price only from real DEX pools (GeckoTerminal, DexScreener fallback) with ≥ $10k liquidity and
  24h volume > 0. Otherwise the UI says there is no market price, and payout quotes are disabled.
- All transfers are signed by the user in their own wallet. No private keys anywhere in this code.
- Basket, PayPal flow and "SSA Proceeds" are simulations and labeled as such.

## Local test
    python3 -m http.server 8765   # then open http://localhost:8765/
    node scripts/update-market-caps.mjs
