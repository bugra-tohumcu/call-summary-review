# Call Summary Review

A browser tool that helps a QA reviewer decide whether a call summary accurately represents its transcript, and whether it needs correcting. The reviewer makes every decision; the tool helps them find and judge the evidence.

Plain HTML, CSS and JavaScript. No framework, no build step, no backend and no AI calls inside the app.

## How to use it
1. Pick a call from the list. You can search by call ID (e.g. `019`) or any word (e.g. `StepChange`), filter by status and sort by priority.
2. Click a summary sentence to see **suggested matching turns** in the transcript, plus any words or numbers in that sentence that appear nowhere in the transcript.
3. Add a finding: the sentence (or "whole summary"), the type, the impact, whether it is definite or uncertain, the cited turn IDs, and an optional note. Findings can be edited or deleted later.
4. Set the verdict: **Accurate** or **Needs correction**.
5. Click **Export JSON** to save all reviews.

## Files
- `index.html`: page structure
- `style.css`: styles
- `app.js`: all logic
- `data.js`: `candidate-calls.json` and `summary-rules.txt`, included unchanged

## Assumptions
- The transcript is the only reference. Nothing is checked against external records.
- There is one reviewer per browser, working on a desktop screen.
- Reviews are stored in the browser (`localStorage`). Export is the only way to keep or share them.
- Findings use the four types from the review guidance: Contradicted, Not supported, Required but omitted, Rule breach.
- A topic that was never discussed is not an omission. It must have been discussed and required by the rules.
- A finding refers to a whole summary sentence (S1, S2...), or to the whole summary for omissions.
- Evidence is cited as call ID plus turn ID (e.g. `CALL-002 T14`).

## Key decisions and why
- **Manual review first, automation second.** The reviewer decides. Anything the tool suggests is labelled as a suggestion.
- **No pre-written AI findings.** They could anchor the reviewer and would need checking anyway. If added later, they will stay visibly marked as AI.
- **Matching is word and number overlap, not AI.** It is transparent and runs offline. Spoken numbers are converted ("two hundred and thirty" matches "£230"), and every amount or date in a sentence pulls in the turn where it was said.
- **Gaps are shown honestly.** "No matching turns found" says the claim may still be right. The list of words that appear nowhere in the transcript says they may be paraphrased or unsupported. Both are prompts to look, not verdicts.
- **Priority score.** It ranks calls by how likely the summary is to mislead a colleague, so a QA lead can triage.
- **Colour is never the only signal.** Types, statuses and certainty always show text as well.
- **Notes are optional,** for speed. The type, sentence and cited turns usually explain the issue.
- **Unsaved work is protected.** Switching call or closing the tab with a half-written finding asks for confirmation first.

## How the build was checked
Each version was tested against the real data in a headless browser before deploying:
- All 20 calls load and every transcript line parses.
- Findings, edits, verdicts, filters, search and export work.
- Matching surfaces known problems, for example:
  - CALL-002: the £150 promise, where T14 shows the customer changing it to £100.
  - CALL-017: "30" appears nowhere in the transcript; the hold was fourteen days.
  - CALL-008: "default, issued" appear nowhere; the default notice was never mentioned.

## Decisions for the business
These values are our assumption, not a business standard. They should be validated with QA leads by scoring a sample of calls by hand and comparing the result with the tool's ranking.
- **Impact points:** High 40, Medium 20, Low 5. Uncertain findings count half. The score is capped at 100.
- **Bands:** High 50+, Medium 20 to 49, Low under 20.
  - Known effect: a single definite High finding scores 40 and shows as "Medium". Options are to lower the High band to 40, or to place any definite High finding in the High band automatically.
- **Default impact by type:** Contradicted and Not supported default to High; Required but omitted and Rule breach default to Medium. The reviewer can change it on each finding.

## What we cut and why
- **Automated rule checks** (call direction, £ amounts next to arrears or "Payment made", missing required phrases, American spellings). Valuable, but cut for time; first in line for future work.
- **Pre-written AI suggestions.** Risk of anchoring the reviewer, and they need verifying.
- **Proposed correction text, import, multiple reviewers and a backend.** Out of scope for 90 minutes; a backend was also outside the brief.

## Known limitations
- **Work can be lost.** Data lives in one browser only, and there is no import of an export.
- **Findings point to sentence numbers.** If the data changes or a sentence splits differently (e.g. "Mr. Smith"), a finding can point at the wrong sentence.
- **One sentence can hold several claims,** so a finding may not say which claim is wrong unless the reviewer adds a note.
- **Matching misses paraphrases.** A match does not prove support, and "no match" does not prove an error. Some words are misread as numbers ("a second", "one-off"). The word stemming misses pairs like pay and payment.
- **"Use as evidence" adds every suggested turn,** including weak ones, which must be removed by hand.
- **Usability:**
  - Long scroll in the left pane.
  - The filtered list can reshuffle while you work.
  - The rules panel is raw text.
  - Export is JSON only.
- **Scale:** built for reviewing a small set by hand, not thousands of calls a week.

## Future work
- **Statistics:** error rates by type, rule and impact across reviewed calls, showing where the summary prompt needs fixing.
- **Reviewer logins and double review:** assign calls, have a sample reviewed twice independently and measure agreement, with an audit trail of changes.
- **Pipeline integration:** load calls automatically from the transcription and summary pipeline. At volume, review a prioritised sample rather than every call.
- **Email button:** a pre-filled email to the responsible colleague or team lead, with the call ID, findings and cited turns. Never to customers.
- **Excel export:** CSV first.
- **Automated rule checks** (layer 2), labelled as automated.
- **AI suggestions,** kept marked as AI after the reviewer accepts them.
- **Fixes for known limitations:**
  - Proposed correction field.
  - Import JSON.
  - Findings anchored to sentence text.
  - "Quoted claim" field.
- **Configurable weights** in settings, not in code.
- **Data protection:** retention rules and access control before any real customer data is used.
- **Speed:** keyboard shortcuts and a "Next unreviewed call" button.
