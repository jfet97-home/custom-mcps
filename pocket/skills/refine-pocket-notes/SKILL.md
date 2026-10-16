---
name: refine-pocket-notes
description: Synthesize and update Pocket AI Notes using a recording's complete transcript, its current edited Notes, and selected structures such as Deep Summary plus Action Summary. Use for enriching, combining or restructuring Notes; use use-pocket-mcp for ordinary reads and individual edits.
---

# Refine Pocket Notes

Produce one coherent Notes document from the complete transcript, the current
Notes and the requested writing structures. Preserve useful existing additions
while improving depth, organization and practical follow-through.

Use the personal `pocket` service through Lunar MCPX. Follow
[use-pocket-mcp](../use-pocket-mcp/SKILL.md) for discovery, authentication and
write recovery. Discover the actual tool names and schemas before calling them.

## Read the right recording and version

- Resolve the recording from the user's request. For the latest conversation,
  compare recording dates and exclude onboarding/tutorial recordings, such as
  `recordingType: getting_started`. The first list entry can be a tutorial.
- Read the complete current transcript with `get_transcript` and the complete
  Markdown with `get_notes`. Search snippets and section summaries are not
  substitutes. If a response is truncated, read the remaining content before
  drafting; avoid printing redundant segment copies when full text is available.
- Retain the recording ID, transcription ID and hash, selected summarization ID,
  Notes row ID and Notes hash. Inspect available versions when selection matters;
  `get_notes` defaults to the most recently updated summarization. Use the
  selected summarization ID consistently through preparation, saving and reread.
- Preserve the actual edited Notes, even when they were previously written with
  another tool. They can contain useful context, proposed wording and follow-up
  ideas that are absent from the transcript.

## Combine the sources

Treat the transcript as evidence of what was said. Treat existing Notes as
material to reconcile and preserve, including the user's additions. Distinguish
events, recollections, interpretations, advice and commitments. When sources
disagree on a material point, resolve it from available evidence or make the
uncertainty explicit.

Retain specific examples, competing explanations and qualifications. Do not
turn a remembered paraphrase into a quotation, a possible cause into an
established finding, or a proposed next step into an agreement. Separate proposed
speaking scripts from words actually spoken. Avoid inferring motives, inventing
owners or deadlines, and promoting jokes into requests.

Adapt to the user's goal and requested language; otherwise retain the current
Notes' language and useful voice. Merge overlapping passages instead of pasting
the transcript and old Notes end to end. A request to combine sources usually
calls for synthesis, not a literal transcript embedded in Notes.

## Apply the requested structures

The following outlines capture the intended organization described by Pocket's
template catalog. They are usable writing instructions; Pocket's complete
backend prompts have not been recovered. Apply the outlines while composing
Markdown locally, then save that supplied Markdown through `update_notes`.

**Deep Summary** (`meeting_super_summarizer`):

- Start with the central concern and the most important takeaways.
- Organize the discussion into substantive themes. Preserve the concrete
  examples, reasoning, tradeoffs, needs and unresolved questions behind them.
- Distinguish what changed, possible explanations and limits of the evidence.
- Include implications and desired outcomes supported by the source material.

**Action Summary** (`meeting_actionable_summary`):

- Extract and prioritize practical next steps, connecting each to its reason.
- Distinguish actions the speaker can take from changes requiring someone
  else's participation or agreement.
- State owners, timing and status when supported; mark proposed assignments
  and unagreed dates explicitly. Preserve existing suggestions as suggestions.
- Include dependencies, questions to resolve and useful follow-up criteria.

For a combined request, a useful structure is **Key takeaways**, **Deep summary**,
**Action summary**, followed by any useful existing conversation outline or
other user-added material. Adjust the sections and length to the recording;
preserving nuance does not require repeating the same point in every section.

For another named template, use its available description to adapt the outline.
Ask for missing instructions only when they materially affect the result. Do not
claim to execute Pocket's native template pipeline or reproduce a hidden prompt.

## Save and verify

A request to update Notes authorizes saving the completed synthesis. A request
for recommendations or a draft alone does not authorize replacing stored Notes.

1. Prepare the complete replacement Markdown. Check that it retains meaningful
   additions from the existing Notes and reflects the transcript faithfully.
2. Reread the selected Notes and transcript immediately before saving. Compare
   their hashes and identities with the sources used for the draft. If either
   changed, incorporate the changes and revise the draft before proceeding;
   do not take a new hash merely to force an outdated replacement.
3. Call `update_notes` once with `recordingId`, the selected `summarizationId`,
   the full replacement `markdown` and the matching Notes `expectedHash`.
   The personal service creates a private raw backup before overwriting and
   verifies its write. Retain the returned `backupId` and hash. The comparison
   is client-side and cannot eliminate every concurrent-edit race.
4. Reread the same Notes version and compare the complete Markdown with the
   intended replacement and the returned hash. Report completion only after
   that verification succeeds.

After a timeout, transport failure or `uncertain_write`, reread before another
mutation: the save may already have applied. If the intended content is present,
verify it rather than resending. Otherwise reconcile the current content with
the draft and backup; do not blindly repeat or restore over another edit.

Keep recording content, drafts and backups outside Git and Docker contexts.
This workflow changes the selected Notes only. Transcript corrections and
global action-item mutations require their own requested scope.

Finish with a concise confirmation naming the recording, the main improvements,
the verified save and the availability of the previous version's backup.
