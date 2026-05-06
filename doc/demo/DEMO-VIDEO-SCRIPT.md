# WasiAI A2A — Demo Video Script

**Format**: 3-minute demo + storyboard
**Audience**: Kite Hackathon judges
**Recording target**: screen capture + voiceover (no face cam needed)

---

## Production setup checklist (before recording)

- [ ] Pre-approve a Passport session 24h TTL ($0.50 max-total) — passkey ONCE
  ```bash
  cd ~/.openclaw/workspace/wasiai-a2a
  kpass agent:session create --ttl 24h --max-amount-per-tx 0.10 --max-total-amount 0.50 \
    --assets USDC --payment-approach x402
  # Click approval URL → passkey
  ```
- [ ] Verify session active: `kpass agent:session list --status active`
- [ ] Verify wallet balance ≥ $0.20 USDC: `kpass wallet balance`
- [ ] Open browser tabs in advance:
  - GitHub repo (https://github.com/ferrosasfp/wasiai-a2a)
  - Snowtrace tx page (one of the mainnet hybrid txs from HACKATHON-FINAL.md)
  - Discord #alerts channel (to show real alert)
- [ ] Open VS Code with these files visible:
  - `src/middleware/passport.ts`
  - `doc/sdd/084-wkh-69-passport-hybrid-inbound/smoke-test-findings.md`
  - `scripts/smoke-passport-autonomous.mjs`
- [ ] Quiet environment, mic check
- [ ] Recording tool: OBS Studio or Loom
- [ ] Export 1080p, MP4

---

## Scene-by-scene

### SCENE 1 — Hook (0:00–0:15) | 15 seconds

**Visual**: 
Title card slide (PITCH-DECK Slide 1 styled), hold for 3 seconds. Then cut to terminal with `tree -L 2 wasiai-a2a/` showing repo structure.

**Voiceover**:
> "Hi. I built WasiAI A2A — the first cross-chain agent payment protocol that natively integrates Kite Passport. In three minutes, real onchain evidence."

---

### SCENE 2 — The problem (0:15–0:35) | 20 seconds

**Visual**:
Three text overlays appearing one by one (left side of screen):

```
❌ Single-chain x402 demos
❌ Manual bridge UX kills adoption
❌ Marketplace = banking middleman
```

While speaking, show on right side a screen recording of typical "bridge USDC from chain X to chain Y" UX (pre-recorded clip showing 4 confirms in MetaMask).

**Voiceover**:
> "x402 demos today are stuck on one chain. Real agents live everywhere. Users shouldn't bridge manually. And every marketplace funnels payments through one operator wallet — that's banking, not protocol."

---

### SCENE 3 — Architecture (0:35–1:00) | 25 seconds

**Visual**:
Animated diagram (Excalidraw or Figma export — animated as elements appear):
1. User box appears (Passport icon)
2. Arrow → wasiai-a2a box (orchestrator)
3. wasiai-a2a fans out → 3 Agent boxes on different chains (Base, Avalanche, Kite logos)
4. Aggregated response arrow back to User

**Voiceover**:
> "Model B Hybrid: Passport handles inbound cross-chain transparently. Our orchestrator fans out to N agents — each settling on its preferred chain. The user signs ONE x402 payment. Gets one aggregated response. Zero bridges, zero approvals."

---

### SCENE 4 — Live demo: pre-balance (1:00–1:20) | 20 seconds

**Visual**:
Terminal in foreground. Show `kpass wallet balance --output json | python3 -m json.tool`. Highlight USDC balance line with arrow/circle.

```
"balance": "2.46",
"symbol": "USDC",
"contract_address": "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
"chain_id": 2366,  ← Kite mainnet
```

**Voiceover**:
> "Live demo, no edits. Here's our Passport wallet on Kite mainnet — 2.46 USDC.e. Watch the balance change in real time."

---

### SCENE 5 — Live demo: execute (1:20–1:50) | 30 seconds

**Visual**:
Terminal — type and run:
```bash
node scripts/smoke-passport-autonomous.mjs
```

Wait for output. Highlight key lines as they appear:
- `[smoke] target=https://parallelmpp.dev/api/search expectedCost=0.01 minBalance=0.05`
- `[smoke] checking active session...`
- `[smoke] found 1 active session(s)`
- `[smoke] pre-balance: 2.46 USDC`
- `[smoke] executing x402 against target...`
- `[smoke] execute success — checking balance settlement...`

Then the JSON output with `"status": "success"`.

**Voiceover**:
> "I'm running our autonomous smoke runner. It uses a pre-approved Passport session — no passkey at runtime. Watch: it captures pre-balance, signs an x402 payment, calls the Parallel x402 service, captures post-balance, verifies the diff matches expected cost. Structured output for CI."

---

### SCENE 6 — The wow: cross-chain transparency (1:50–2:15) | 25 seconds

**Visual**:
Highlight in the JSON output:
```json
"x402": {
  "chain_id": 8453,    ← BASE MAINNET
  "method": "POST"
},
"balance_diff_usdc": 0.01,
"diff_within_tolerance": true
```

Then show side-by-side:
- Left: kpass wallet balance (showing wallet on chain 2366 Kite mainnet)
- Right: x402.chain_id from output (8453 Base)

Add overlay text: **"Cross-chain transparent: Kite → Base"**

**Voiceover**:
> "**This is the wow.** Our wallet is on Kite mainnet, chain 2366. The service got paid on Base mainnet, chain 8453. Passport handled the bridge silently. The user never saw it. The wallet just shows minus one cent. **This is what cross-chain UX should feel like.**"

---

### SCENE 7 — Production-grade discipline (2:15–2:35) | 20 seconds

**Visual**:
Cut to GitHub PRs page (filtered to merged PRs in main). Show the list of 20 PRs from PR #59 to PR #79 in date order. Highlight the WKH-69 PR (#76).

Then cut to terminal: `npm test 2>&1 | tail -3` showing `Tests 816 passed (816)`.

**Voiceover**:
> "Behind this: 20 PRs in 6 days. Every one through an 8-phase pipeline with sub-agent orchestration — analyst, architect, dev, adversary, QA, docs. Six PRs found zero blockers in adversarial review. 816 tests passing. Production discipline on hackathon timeline."

---

### SCENE 8 — Catalog dialogue with Kite team (2:35–2:50) | 15 seconds

**Visual**:
Split screen:
- Left: terminal showing `ksearch services list` → highlighted output `10 service(s).`
- Right: Discord screenshot with the **Kite team's official reply**, key sentence underlined:
  > "no self-service flow right now as they're keeping a close eye on catalog quality... we're expanding ksearch."

Lower-third overlay text: **"Curation = quality. Built ready for the expansion."**

**Voiceover**:
> "ksearch is intentionally curated — Kite team confirmed it directly. We respect that. Catalog quality matters. Our service is hardened and ready when ksearch expands to verified builders."

---

### SCENE 9 — Closing (2:50–3:00) | 10 seconds

**Visual**:
Final card (Slide 14 styled):
```
WASIAI A2A

✅ Cross-chain Passport-funded
✅ 20 PRs / 816 tests / live mainnet
✅ $0.061 + $0.01 onchain proof

github.com/ferrosasfp/wasiai-a2a
```

Hold for 5 seconds. Fade.

**Voiceover**:
> "WasiAI A2A. Real production code, real onchain proof, native Kite Passport. Repo's open. Thank you."

---

## Total breakdown

| Scene | Duration | Cumulative |
|-------|----------|------------|
| 1 — Hook | 0:15 | 0:15 |
| 2 — Problem | 0:20 | 0:35 |
| 3 — Architecture | 0:25 | 1:00 |
| 4 — Pre-balance | 0:20 | 1:20 |
| 5 — Execute | 0:30 | 1:50 |
| 6 — Cross-chain wow | 0:25 | 2:15 |
| 7 — Discipline | 0:20 | 2:35 |
| 8 — Feedback | 0:15 | 2:50 |
| 9 — Closing | 0:10 | 3:00 |

---

## Production tips

- **Practice the kpass execute timing**: it takes ~5-10 seconds. Don't rush voiceover during dead time — let the terminal output speak.
- **Pre-script the smoke output**: if the live execute fails (network, allowlist, etc.), have a backup pre-recorded clip ready.
- **Highlight chain IDs visually**: viewers won't catch "2366 vs 8453" by ear. Use circles/arrows in post.
- **Frame the ksearch story as a dialogue, not a complaint**: Kite team confirmed curation is intentional. The narrative is "we engaged, they confirmed, we respect it, we're ready for expansion" — judges respect engineering maturity more than "we found a gap".
- **Music**: subtle electronic/synth track (royalty-free), volume -25dB so voiceover dominates.

---

## Backup plan if Passport smoke fails live

If `kpass agent:session execute` returns an error during recording:

**Option A — fallback to wire-evidence file**:
```bash
cat doc/sdd/084-wkh-69-passport-hybrid-inbound/wire-evidence/parallel-200-evidence.json | python3 -m json.tool | head -30
```
Voiceover: "Here's wire evidence captured on May 4 — production hybrid running."

**Option B — fallback to mainnet hybrid evidence**:
Show Snowtrace tx page from HACKATHON-FINAL.md (e.g. `0x4b3bab43...`).
Voiceover: "Here's $0.05 USDC mainnet, settled on Avalanche, captured during sprint 4."

Either fallback maintains the "real onchain proof" narrative without depending on live ksearch availability.

---

## Editing notes

- **Cuts**: hard cuts between scenes (no fade except scene 9)
- **Captions**: include burnt-in subtitles for accessibility (English; optional Spanish track)
- **Color grade**: slight teal/cyan boost for tech feel
- **Export**: H.264, 1080p30, AAC audio @ 192kbps, ~150MB final size

Final upload target: hackathon submission portal + LinkedIn post + Twitter thread linking to demo video URL.
