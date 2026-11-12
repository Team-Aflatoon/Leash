# Submission checklist

Checked against the requirements table in the hackathon brief (PayPal_Hackathon_Idea.pdf, section 3). "Evidence"
points at real files or commands. Items marked **YOU** need the owner's accounts or hands.

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Meaningfully use PayPal (sandbox) | Built; **YOU** run the spike with real credentials | `apps/gateway/src/paypal.ts` (Vault v3, Orders v2 AUTHORIZE, capture, void, webhook verify); `docs/PAYPAL_FACTS.md`; `docs/SANDBOX_LOG.md` must show a successful spike run |
| Meaningfully use AI | Built | `apps/gateway/src/claude.ts` (mandate drafting, intent check), `apps/agent/src/shopper.ts` (tool-use agent) |
| Working prototype judges can run | **YOU** deploy | `render.yaml`, `Dockerfile`; README "Judge walkthrough" (fill in demo URL and sandbox buyer login) |
| Public repo with open-source license | **YOU** create the repo and push | `LICENSE` (MIT). Set the repo's About section to show the license. |
| Demo video under 3 minutes | **YOU** record | `docs/VIDEO_SCRIPT.md` (2:55 plan). Public YouTube, no trademarks, no copyrighted music. |
| Text description and tools used | Ready | `docs/DEVPOST.md`, README "Tools used" |
| Optional sponsor: AG Grid | Used | `apps/console/src/views/Grids.tsx` (decisions and ledger grids) |
| Optional sponsor: Render | Used once deployed | `render.yaml` |
| Optional sponsor: Channel3 | Not used | Deliberate: avoids real brand images in the video (brief, section 3) |

## Before submitting
- [ ] `pnpm typecheck && pnpm test` green; `bash scripts/mutation-check.sh` → 20/20 killed; `npx tsx scripts/smoke.ts <demo-url>` → 6/6 once PayPal is linked
- [ ] Spike run recorded in `docs/SANDBOX_LOG.md` with "P4 CONFIRMED"
- [ ] Hosted demo: create owner → link PayPal → Run red team → 6/6
- [ ] Webhook registered; a capture shows "CONFIRMED" in the Decisions grid's Webhook column
- [ ] README placeholders filled: https://leash-pwu7.onrender.com, `<VIDEO_URL>`, `<SANDBOX_BUYER_EMAIL>`, `<SANDBOX_BUYER_PASSWORD>`
- [ ] Video public on YouTube, under 3:00
- [ ] Devpost text pasted from `docs/DEVPOST.md`
- [ ] Only one sponsor prize can be won: pick AG Grid as the primary sponsor track
