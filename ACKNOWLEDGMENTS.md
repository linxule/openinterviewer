# Acknowledgments

OpenInterviewer grows through contributions, working forks and feedback from
people conducting real research. Thank you for sharing what works, what is
missing and how you have adapted the project.

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
