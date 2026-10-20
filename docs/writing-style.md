# Documentation writing style

English | [한국어](ko/writing-style.md)

Artifacty applies the clarity principles of ASD-STE100 to English and Korean documentation. Use complete sentences, consistent terms, and explicit conditions. Adapt these principles to the language and the reader; this guide does not claim compliance with ASD-STE100.

The project's earlier “75%” target describes a flexible editorial approach, not a compliance score. Do not count words or enforce a controlled vocabulary at the expense of meaning.

## Sentences and terms

- Give each sentence a clear main point. Keep closely related clauses together when separating them would obscure a condition, cause, or exception.
- Name the actor when responsibility matters: the administrator, the artifact owner, the user, or the server. Avoid repeating a subject that is already clear.
- Prefer active voice. Passive voice is appropriate when the actor is unknown or the result matters more.
- Use the same term for the same concept. Match UI labels, API fields, and CLI commands exactly.
- Keep established terms such as artifact, MCP, webhook, and CIDR. Explain unfamiliar terms when readers first need them.
- Write complete explanations. Keep words that identify what changes, who can act, and when a rule applies.
- Do not impose a fixed sentence length or replace precise terms to fit a controlled dictionary.

## Instructions and behavior

- State prerequisites and conditions before the action they govern.
- Give each numbered step one main action. Include the command or UI control needed to perform it. Keep related checks with the action when this makes the procedure easier to follow.
- State the expected result and how to check it when readers need to verify success.
- Preserve defaults, permissions, exceptions, failure behavior, and recovery requirements. Do not remove these details to make a paragraph shorter.
- Distinguish requirements from recommendations and options. Preserve the meaning of MUST, SHOULD, and MAY in specifications.
- Preserve commands, identifiers, URLs, example values, and technical constraints. If an example conflicts with the current implementation, verify the behavior before correcting it.
- Identify proposals and historical decisions. Do not describe a planned feature as available in the current release.

## Apply by document type

Use these rules most carefully in installation procedures, API references, and security guidance. README introductions and design rationale can use longer, connected prose when it helps explain the subject. Brevity is useful only when the reader still has enough information to act correctly.

For example:

> By default, share links do not work in private mode. An administrator must enable them in Access settings.

The example states the default, the responsible actor, and the setting location.

Refer to the [official ASD-STE100 overview](https://www.asd-ste100.org/about.html) for the specification's purpose and structure.

## Required documentation workflow

1. Check commands, option names, defaults, permissions, limits, and response fields against the current implementation. Separate released behavior, repository changes awaiting release, and proposals. A historical design is not evidence of current behavior.
2. Update the English and Korean guides together. Keep the documentation indexes and relevant sample manuals in sync. Changes to sample source do not replace manuals already installed in a user's store.
3. For each documented browser feature, place an actual English UI screenshot beside its steps and explain what it demonstrates. A few overview screenshots do not replace feature-specific screens. Capture expanded controls or useful example states when needed. Use an isolated temporary store with fictional data. Never capture production artifacts, credentials, personal information, or real access tokens.
4. Wait for fonts, diagrams, and other asynchronous content to finish rendering. Inspect each image for correct labels, readable text, clipping, loading errors, and sensitive content. State the account or access-mode context when it changes the available controls. Share screenshots between translations; translate their captions and alt text.
5. Save screenshots under `docs/assets/screenshots/`. Verify relative links and npm inclusion. Do not alter screenshots to imply controls or behavior that the product does not have.
6. Run `npm run docs:check` to check local Markdown links, section anchors, and packaged documentation/images. It does not validate external URLs or command behavior. Check changed commands separately in a disposable store and temporary client configuration paths. A shell syntax check alone does not prove a command works.
7. Run the relevant behavior tests, `npm run lint`, and `npm test` before reporting completion. For a release, also run `npm run release:check`. Verify browser instructions in the running app. For destructive operations, external mail, or production deployment, use isolated fixtures or a safe preview; record any operation you did not execute.
8. Report changed files, verified behavior, screenshot locations, test results, and remaining limits. Do not claim that all documentation is error-free based only on automated checks.

## 한국어 문서 작성 기준

한국어에도 STE-100의 명료성 원칙과 fluent-korean 지침을 함께 적용합니다. 두 기준이 충돌하면 **기술적 의미의 정확성 → 자연스러운 한국어 → 문장 길이와 형식 규칙** 순으로 판단합니다. 영어 어순이나 단어 수 제한을 그대로 적용하지 않습니다.

- 문장마다 핵심 내용을 분명히 밝힙니다. 조건과 결과, 원인과 예외가 밀접하게 연결되어 있다면 한 문장으로 설명해도 됩니다.
- 의미를 이해하는 데 필요한 주체와 대상을 생략하지 않습니다. 권한이나 책임을 구분할 때는 주체를 밝히되, 문맥상 분명한 주어는 반복하지 않습니다.
- 조사와 어미를 갖춘 완전한 문장으로 씁니다. 제목과 표에서는 간결한 명사구를 사용할 수 있지만, 설명문을 메모처럼 압축하지 않습니다.
- 조건과 전제를 먼저 설명한 뒤 행동을 안내합니다. 절차에는 필요한 확인 방법과 예상 결과를 함께 적습니다.
- 번역투, 불필요한 수동 표현, 명사 나열을 줄입니다. ‘설정의 변경이 가능합니다’보다 ‘설정을 변경할 수 있습니다’로 씁니다. 수동 표현이 의미를 더 정확하게 전달한다면 유지합니다.
- 같은 개념에는 같은 용어를 사용합니다. UI 이름은 해당 언어의 실제 표기와 맞추고, 명령어·API 필드·코드 식별자는 바꾸지 않습니다. 정착된 번역어가 없다면 원어를 유지하고 필요한 설명을 덧붙입니다.
- 생소한 비유나 긴 대시로 관계를 압축하지 않습니다. 문맥에 맞는 접속사나 별도 문장으로 원인, 조건, 대조 관계를 설명합니다.
- 기본값, 예외, 제한, 복구 조건을 빠뜨리지 않습니다. ‘반드시 해야 합니다’, ‘권장합니다’, ‘할 수 있습니다’를 구분해 의무의 강도를 보존합니다.
- 설명은 ‘합니다’체로 쓰고, 절차는 ‘선택하세요’, ‘실행하세요’처럼 안내합니다. 코드, 식별자, 인용문, 로그와 라이선스 원문에는 문체 규칙을 기계적으로 적용하지 않습니다.

예를 들어 다음과 같이 씁니다.

> 비공개 모드에서는 기본적으로 공유 링크를 사용할 수 없습니다. 관리자가 접근 설정에서 공유 링크를 허용해야 합니다.

문장을 나눌 때는 적용 조건이 달라지지 않는지 확인합니다. ‘백업 검증에 성공하면 서버를 중지하고 복구를 시작하세요’에서 검증 조건을 빼고 행동만 남겨서는 안 됩니다. 자연스러운 문장과 기술적 정확성을 함께 유지하는 것이 목표입니다.
