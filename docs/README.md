# Documentation

English | [한국어](ko/README.md)

Start with the [project README](../README.md) for installation, features, CLI commands, and environment variables.

## User and operator guides

| Document | English | 한국어 |
| --- | --- | --- |
| Installation and feature reference | [README](../README.md) | [README](../README.ko.md) |
| Agent integrations | [Guide](integrations.md) | [연동 안내](ko/integrations.md) |
| Network sharing | [Guide](network-sharing.md) | [네트워크 공유](ko/network-sharing.md) |
| Upgrade snapshots and recovery | [Guide](upgrade-backups.md) | [업데이트 백업과 복구](ko/upgrade-backups.md) |
| MCP public API | [Reference](mcp-public-api.md) | [MCP API 참조](ko/mcp-public-api.md) |
| Artifact schema v1 | [Reference](artifact-schema-v1.md) | [아티팩트 스키마](ko/artifact-schema-v1.md) |
| Security policy | [Policy](../SECURITY.md) | [보안 정책](../SECURITY.ko.md) |
| Threat model | [Reference](threat-model.md) | [위협 모델](ko/threat-model.md) |
| Release checklist | [Checklist](release-checklist.md) | [릴리스 체크리스트](ko/release-checklist.md) |
| Documentation writing style | [Guide](writing-style.md) | [문서 작성 기준](ko/writing-style.md) |

## Design and implementation history

These documents are currently available in English. They contain proposals and historical implementation notes; a planned feature is not necessarily available in the current release.

- [Central team deployment](central-team-deployment-design.md)
- [Roadmap and design](roadmap-design.md)
- [Claude artifact formats](claude-artifact-formats.md)
- [SARIF and CSV artifact support](sarif-csv-artifact-plan.md)

## Translation maintenance

- Keep `README.md` as the default English entry point and `README.ko.md` as its Korean counterpart. Detailed Korean documents mirror filenames under `docs/ko/`.
- Keep language links in both directions. Prefer translated links when available; label English-only references clearly.
- Preserve commands, API identifiers, example values, defaults, permission rules, and requirements. Translate prose using the [writing style guide](writing-style.md).
- Update both languages in the same pull request when behavior changes. If a translation cannot be updated, mark it as outdated and link to the current English section.
- Each translation records its source revision in an HTML comment. Update that revision after checking the translation against the source. The initial translations use revision `9e73a9f`.
- Verify relative links, section anchors, code examples, and environment-variable coverage before merging. Do not execute destructive or production commands just to verify a translation.
- Repository translations do not change browser language settings or replace manuals already installed as sample artifacts.
