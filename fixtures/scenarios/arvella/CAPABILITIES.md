# Arvella E2E Draft Capabilities

이 폴더는 Arvella 서버가 준비된 뒤 실제 값만 연결할 Scenario v2 초안입니다. `Service`와 `ServerPack`을 수정하거나 서버를 시작·재시작하지 않습니다.

## 현재 CLI에서 사용 가능

| 기능 | 사용 명령 | 용도 |
| --- | --- | --- |
| 이름·표식 기반 NPC 선택 | `actor interact-role` | Shop/Quest NPC를 엔티티 ID와 무관하게 선택 |
| capability 확인 | `actor capabilities` | headless/visual 지원 여부를 명시적으로 실패 처리 |
| GUI 제목·아이템·Lore 검사 | `session expect-window` | 상점, 퀘스트 목록, 직업 제한 표시 확인 |
| 의미 기반 GUI 클릭 | `session click-item` | 퀘스트, 수락, 길안내, 캐릭터 선택 |
| Actionbar 관측 | `session expect-event --type action_bar` | 길안내 문구와 이벤트 cursor 이후 발생 확인 |
| visual 위치 캡처와 타입 보존 비교 | `visual state` + Scenario v2 `capture` | 같은 렌더링 클라이언트의 캐릭터 재선택 전후 dimension/x/y/z 비교 |
| 실패 진단 | failure capsule | assertion, 상태 diff, 이벤트, 연결 상태 저장 |

## Arvella 통합 시 확정할 값

각 JSON의 `variables`만 실제 서버 계약에 맞게 바꿉니다.

- Shop/Quest NPC의 표시 이름 또는 scoreboard/team/tag 기반 role 문자열
- 상점·퀘스트·캐릭터 선택 GUI 제목
- 퀘스트 아이템 이름, 요구 직업 Lore, 수락·길안내 버튼 이름
- 수락·완료·길안내 Actionbar의 안정적인 평문 식별자
- 허용 직업과 완료 조건이 준비된 E2E 캐릭터
- `completionTriggerCommand`: 운영 명령이 아니라 격리 테스트 profile에서 승인된 완료 조건 발생 방식
- Character NPC role과 Dialog에서 대상 캐릭터가 노출되는 안정적인 action index
- 재선택 시 같은 연결 유지 또는 proxy 전환 여부

## 실행 전제

- Shop/Quest 초안은 `arvella-e2e` headless 세션이 기본입니다.
- Character 초안은 NPC와 native Dialog, 동일 클라이언트 위치 비교가 모두 필요하므로 연결된 `1.21.11` visual 세션 `arvella-character-visual`을 사용합니다.
- NPC와 GUI가 상호작용 거리 안에 있도록 테스트 fixture가 플레이어 위치를 준비해야 합니다.
- `job-restricted-quest.json`은 요구 직업을 가진 캐릭터의 표시→수락→완료 흐름입니다. 다른 직업의 거절 흐름은 실제 거절 메시지와 UI 계약이 정해진 뒤 별도 시나리오로 분리합니다.
- Character의 NPC 클릭, Dialog action, 위치 복원은 한 visual 세션에서 자동화하도록 초안과 adapter 소스를 준비했습니다. adapter 정식 빌드와 실제 Arvella binding을 적용한 E2E는 아직 남아 있습니다.
- 글꼴, 버튼 배치, 색상, Lore 같은 시각 디자인은 screenshot 기반 수동 또는 vision 확인 대상으로 남습니다.
- Paper Probe는 필수가 아닙니다. 서버측 취소 여부나 권한 결과가 필요할 때 격리 test profile에서만 선택 사용합니다.

## 현재 검증 상태

- 네 시나리오의 dry-run과 Scenario v2 자체 테스트는 통과했습니다.
- visual lifecycle 자체 테스트는 통과했습니다.
- 이 환경에서는 Fabric Loom이 Windows 임시 intermediary JAR의 lock 정보를 조회하지 못해 adapter Java 컴파일 전에 중단됩니다. 소스 컴파일 오류가 확인된 것은 아니며, 일반 사용자 환경의 adapter 빌드로 최종 확인해야 합니다.
- 실제 Arvella 서버 연결, 데이터 변경, 런타임 재시작은 수행하지 않았습니다.
