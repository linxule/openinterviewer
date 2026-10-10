# Projects register — 5.3 implementation surface

Bound by `projects-5.3-design.md` and its overriding `projects-5.3-decisions.md`.
No new visual primitive: reuse Button, Coordinate, Icon, Notice, Measure, Rule,
the existing register columns and the Tailwind 4 tokens in `globals.css`.

- Standalone only. Mode must be positively identified before project requests.
  Hosted keeps its reconciliation and flat register. A mode/project failure or
  mismatched study roster shows a notice and a flat list, never guessed grouping.
- Show every project, including empty projects, followed by Ungrouped. Disclosure
  buttons expose `aria-expanded` and `aria-controls`, name and study count.
  Collapse puts focus on the disclosure. State stays component-local.
- The top-level New project action uses a native name prompt. Project actions use
  a labelled ··· disclosure with ordinary tab-accessible buttons: Rename,
  Export transcripts, Delete project. Escape closes and restores trigger focus.
- + Study opens `/setup?projectId=<id>`. Row actions retain their prior operations,
  adding Move to project… (a labelled native select) and Ungroup. Row arrow keys
  move through visible rows across sections without wrapping. Hidden rows are skipped.
- Touch actions are at least 44px. Project headers wrap at narrow widths; the
  register retains its responsive hidden columns and local horizontal overflow.
  Browser inspection at 375px is a required external verification.
- Delete confirmation is exactly: “Delete this project? Its studies will move to
  Ungrouped. No study or interview will be deleted.” Pending actions are disabled;
  uncertain writes reload without automatic retry or assumed success.
- Study creation retains its existing create idempotency, scoped to the explicit
  project intent, but has no pending-assignment record. After a failed membership
  PUT, navigate to the saved study with: “Study saved, but it was not added to
  <project>. Move it from the study list.” A removed/unreadable project whose name
  was never loaded is identified by its non-secret ID.
