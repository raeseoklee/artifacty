# Documentation writing style

English | [한국어](ko/writing-style.md)

Artifacty uses an ASD-STE100-inspired style for English documentation. Korean documentation follows the same clarity principles with natural Korean phrasing. This is an editorial guide, not a claim of compliance with ASD-STE100.

Apply the sentence and procedure rules consistently. Use technical vocabulary where it makes the meaning more precise. Keep introductions natural. The project's “75%” target describes this balance; it is not a compliance score.

## Sentences and terms

- Give each sentence one main idea. Split long sentences when this improves clarity.
- Name the actor when responsibility matters: the administrator, the artifact owner, the user, or the server.
- Prefer active voice. Use passive voice when the actor is unknown or does not matter.
- Use the same term for the same concept. Match UI labels, API fields, and CLI commands exactly.
- Keep established terms such as artifact, MCP, webhook, and CIDR. Explain unfamiliar terms on first use.
- Keep words that make a sentence complete. Do not turn prose into compressed notes.
- Do not enforce a fixed word limit or replace precise terms only to fit a controlled dictionary.

## Instructions and behavior

- State prerequisites and conditions before the action.
- Give each numbered step one action. Show the command or UI control that performs it.
- State the expected result when readers need it to verify the action.
- Make defaults, permissions, exceptions, and recovery behavior explicit.
- Keep requirements and recommendations distinct. Preserve the meaning of MUST, SHOULD, and MAY in specifications.
- Preserve commands, identifiers, URLs, examples, and technical constraints when editing prose.
- Describe planned features as planned. Do not present a design proposal as current behavior.

## Apply by document type

Use these rules most strictly in installation instructions, API references, and security documentation. Allow more connected prose in the README introduction, design rationale, and launch posts. Keep the explanation readers need; shorter text is not useful if it omits a condition or exception.

For example:

> By default, share links do not work in private mode. An administrator must enable them in Access settings.

This states the default, the responsible actor, and the setting location.

Refer to the [official ASD-STE100 overview](https://www.asd-ste100.org/about.html) for the specification's purpose and structure.

## 한국어 문서 작성 기준

한국어 문서에도 같은 명료성 원칙을 적용합니다. 다만 영어의 문장 구조나 어휘 규칙을 그대로 옮기지 않고, 자연스러운 한국어 어순과 흐름을 살립니다. ‘75% 강도’는 편집 방향을 뜻하며, 표준 준수율을 뜻하지 않습니다.

- 한 문장에는 하나의 핵심 내용을 담습니다. 서로 밀접한 내용은 자연스럽게 연결하고, 짧게 쓰기 위해 문장을 지나치게 끊지 않습니다.
- 조건이나 전제는 행동보다 먼저 설명합니다. 절차는 단계별로 나누고, 필요한 경우 예상 결과와 확인 방법을 덧붙입니다.
- 권한이나 책임을 구분해야 할 때는 주체를 밝힙니다. 문맥상 분명한 주어는 반복하지 않습니다.
- 번역투, 불필요한 수동 표현, 명사만 나열하는 문장을 피합니다. 예를 들어 ‘설정의 변경이 가능합니다’보다 ‘설정을 변경할 수 있습니다’로 씁니다.
- 같은 개념에는 같은 용어를 사용합니다. 화면 이름은 해당 언어의 실제 UI 표기와 맞추고, 명령어·API 필드·코드 식별자는 그대로 유지합니다.
- 익숙한 기술 용어는 억지로 번역하지 않습니다. 설명이 필요한 용어는 처음 나올 때 간단히 풀이합니다.
- 기본값, 예외, 제한, 복구 조건을 생략하지 않습니다. 필수 사항과 권장 사항도 명확히 구분합니다.
- 설명문은 ‘합니다’체를 기본으로 씁니다. 절차에서는 필요한 행동을 ‘선택하세요’, ‘실행하세요’처럼 직접 안내합니다.

예를 들어 다음과 같이 씁니다.

> 비공개 모드에서는 기본적으로 공유 링크를 사용할 수 없습니다. 관리자가 접근 설정에서 공유 링크를 허용해야 합니다.

설치·API·보안 문서에는 이 기준을 엄격하게 적용합니다. 소개 글과 설계 배경에서는 정확성을 유지하면서 문장이 자연스럽게 이어지도록 씁니다.
