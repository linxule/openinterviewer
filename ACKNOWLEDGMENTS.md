# Acknowledgments

OpenInterviewer grows through contributions, working forks and feedback from
people conducting real research. Thank you for sharing what works, what is
missing and how you have adapted the project.

## Version 5.1.0: languages, voice input and transcript export

Thank you again to [@8888oukaouka-spec](https://github.com/8888oukaouka-spec) for
the next round of the [openinterviewerver02](https://github.com/8888oukaouka-spec/openinterviewerver02)
fork and for describing how her studies run.

| Contribution | How it informed OpenInterviewer 5.1.0 | Source |
| --- | --- | --- |
| A one-file Markdown export of a study's (and project's) transcripts, ready for further analysis | **Export transcripts (.md)**: one escaped Markdown file per study that records, for each interview, what its participant was told about the AI | [Fork commit `2ce177b`](https://github.com/8888oukaouka-spec/openinterviewerver02/commit/2ce177bb88b0af878b8d6345455d9712caec923f) |
| Prompt changes that ask participants their preferred language and continue in it, and a language picker for voice input | **Interview Languages**: participants choose from up to six languages; consent, screens and interviewer follow, and consent is bound to the language read | [Fork commit `44fed5c`](https://github.com/8888oukaouka-spec/openinterviewerver02/commit/44fed5c3cbf51df34c951641ca47774d4322afc5), [`3e5f1f5`](https://github.com/8888oukaouka-spec/openinterviewerver02/commit/3e5f1f5a09a6fee6fc9d46a606561fb2eda2f604) |
| A microphone on the participant screen using the browser's speech recognition | **Voice Input**, transcribed by the installation's Cloudflare Workers AI or the browser's dictation, each named in the consent notice | [Fork commit `3e3e999`](https://github.com/8888oukaouka-spec/openinterviewerver02/commit/3e3e9994c52c08894cc2ef4326dd8ccf1618c1e0), [`9e3de91`](https://github.com/8888oukaouka-spec/openinterviewerver02/commit/9e3de918104c4b6d13c7563e6fd9105b88e7d124) |

As in 5.0.0, the fork commits were reviewed as product and interaction references
and reimplemented against the current storage and consent contracts; none was
cherry-picked. Her project grouping (studies within projects) is planned for a
later release with its own storage migration.

## Version 5.0.0: researcher control and evidence exploration

Thank you to [@8888oukaouka-spec](https://github.com/8888oukaouka-spec), maintainer
of [openinterviewerver02](https://github.com/8888oukaouka-spec/openinterviewerver02),
for testing the interviewer-manner settings, sharing a working fork and
describing how researchers need to revisit the same interview dataset.

| Contribution | How it informed OpenInterviewer 5.0.0 | Source |
| --- | --- | --- |
| A Study Settings Danger Zone with confirmed deletion of a study and its interviews | The study-local deletion journey, with two confirmations and cleanup of associated live research data | [Fork commit `b42f8db`](https://github.com/8888oukaouka-spec/openinterviewerver02/commit/b42f8dbc17e7121535cf1215cf41d36e876568ba) |
| Aggregate analysis across study revisions | Explicit historical dataset selection and aggregate analysis bound to the selected sources | [Fork commit `8f3fe57`](https://github.com/8888oukaouka-spec/openinterviewerver02/commit/8f3fe5752ac42934c7d078f548114f9a01c3985d) |
| A proposal to explore interview data conversationally: archetypes, recorded-profile segments, hypothesis evidence and unexpected themes | The study Explore workspace, saved answers, exact source manifests and quote-location controls | Researcher feedback shared with the maintainer alongside the fork |

The fork supplied a working deletion prototype and highlighted the historical
analysis need. These were reviewed as interaction and workflow references;
the two linked commits were not cherry-picked. Version 5 implements these
capabilities against the project's current storage, revision and consent
contracts. The exploration assistant is a new implementation inspired by the
researcher's proposal, not a chat implementation imported from the fork.

See the [v5.0.0 release notes](docs/releases/v5.0.0.md) and
[contribution guidance](CONTRIBUTING.md#credit-and-provenance).
