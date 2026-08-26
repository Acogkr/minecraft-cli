# minecraft-cli

Paper 플러그인을 테스트하기 위한 Minecraft 클라이언트 CLI입니다.

이미 실행 중인 Paper 서버에 접속해 채팅과 명령을 보내고, GUI를 클릭하거나 현재 상태를 JSON으로 확인할 수 있습니다. 실제 화면 확인이 필요할 때는 MultiMC 클라이언트를 열어 GUI, Lore, 채팅 hover, 다이얼로그, 토스트 등을 스크린샷으로 남깁니다.

서버를 설치하거나 실행하는 기능은 포함하지 않습니다.

## 지원 환경

- Windows
- Node.js 20 이상
- Java 21 (`1.20.1` 화면 클라이언트용 Java 17은 필요할 때 자동 준비)
- MultiMC
- 접속 가능한 Paper 서버

지원하는 Minecraft 버전은 `1.20.1`, `1.21.4`, `1.21.11`입니다. offline 접속이 기본이며 Microsoft 계정도 선택해서 사용할 수 있습니다.

## 설치

프로젝트 폴더에서 다음 명령을 실행합니다.

```powershell
npm install
npm run install:global
```

설치가 끝나면 다른 프로젝트에서도 `minecraft-cli` 명령을 바로 사용할 수 있습니다.

```powershell
minecraft-cli --help
```

MultiMC가 기본 경로에 없다면 `MULTIMC_ROOT` 환경 변수에 MultiMC 폴더를 지정합니다.

## Microsoft 계정

Mineflayer 세션에서 Microsoft 계정을 사용하려면 처음 한 번만 로그인합니다. `main`은 이메일이 아니라 이 컴퓨터에서 사용할 계정 별칭입니다.

```powershell
minecraft-cli auth login main
```

명령을 실행하면 인증 코드가 미리 채워진 Microsoft 공식 로그인 페이지가 기본 브라우저로 열립니다. 같은 코드는 클립보드에도 복사되므로 자동 입력이 되지 않아도 바로 붙여 넣을 수 있습니다. 브라우저에서 계정 로그인과 최초 승인을 마치면 인증 정보가 저장되며, 만료되거나 직접 로그아웃하기 전까지 같은 별칭을 다시 사용할 수 있습니다.

브라우저를 열거나 클립보드를 변경하면 안 되는 자동화 환경에서는 각각 끌 수 있습니다.

```powershell
minecraft-cli auth login main --no-browser
minecraft-cli auth login main --no-clipboard
minecraft-cli auth login main --no-browser --no-clipboard
```

토큰은 프로젝트 폴더가 아닌 Windows 사용자 전용 `LocalAppData`에 보관되며 JSON 결과에는 출력되지 않습니다.

```powershell
minecraft-cli --json auth status
minecraft-cli --compact --json session create bot1 `
  --auth microsoft `
  --account main `
  --host play.example.com `
  --port 25565 `
  --version 1.21.4 `
  --connect
```

로그인 정보를 지우려면 다음 명령을 사용합니다.

```powershell
minecraft-cli auth logout main
```

## 빠르게 테스트하기

대부분의 기능 검사는 가벼운 Mineflayer 세션으로 먼저 진행하는 편이 빠릅니다. 아래 예시는 `127.0.0.1:25565`에서 실행 중인 `1.21.4` 서버에 접속합니다.

```powershell
minecraft-cli --compact --json session create bot1 `
  --username BotOne `
  --host 127.0.0.1 `
  --port 25565 `
  --version 1.21.4 `
  --connect
```

접속한 뒤 명령을 실행하고 필요한 상태만 확인할 수 있습니다.

```powershell
minecraft-cli --compact --json session command bot1 mcgui
minecraft-cli --compact --json session state bot1 --part window
minecraft-cli --compact --json session click-item bot1 --item book --lore "slot 20"
minecraft-cli --compact --json session look-at bot1 --role "상점 NPC" --max-distance 10
minecraft-cli --compact --json session interact bot1 --role "상점 NPC" --max-distance 10
```

세션 이름이 다르면 서로 독립적으로 동작하므로 여러 클라이언트를 동시에 접속해도 됩니다.

## 여러 단계를 한 번에 실행하기

반복 테스트는 명령을 하나씩 호출하지 않고 JSON 시나리오로 묶을 수 있습니다. 기본 출력은 단계별 성공 여부와 실행 시간만 반환하고, 전체 compact 응답은 `.minecraft-cli/runs`에 저장하므로 AI가 읽는 토큰과 AI·CLI 사이의 왕복을 줄일 수 있습니다.

```powershell
minecraft-cli --json scenario docs/scenario.example.json --dry-run
minecraft-cli --json scenario docs/scenario.example.json
```

새 시나리오는 `version: 2`를 사용합니다. 이전 `version: 1` 파일도 그대로 실행됩니다.

```json
{
  "version": 2,
  "name": "gui-smoke",
  "variables": { "session": "bot1" },
  "steps": [
    { "name": "open", "args": ["session", "command", "${session}", "mcgui"], "retry": 2 },
    {
      "name": "read-window",
      "args": ["session", "state", "${session}", "--part", "window"],
      "assertions": [{ "path": "$.data.window.slots[10].name", "contains": "paper" }],
      "capture": { "title": "$.data.window.title" }
    },
    { "name": "cleanup", "args": ["session", "destroy", "${session}"], "when": "always" }
  ]
}
```

- `${변수}`는 초기 변수나 `capture` 결과를 다음 단계에 전달합니다.
- assertion은 `equals`, `notEquals`, `contains`, `matches`, `exists`, `gt`, `gte`, `lt`, `lte`를 지원합니다.
- 단계별 `retry`, `repeat`와 2~8개 작업의 `parallel` 그룹을 사용할 수 있습니다.
- 실패하면 명령, assertion, 상태 diff, 이벤트 구간, 데몬·Probe 상태를 담은 capsule JSON이 하나 생성됩니다. 비밀값은 마스킹됩니다.
- 시나리오는 `status`, `session`, `visual`, `actor`, `probe`, `cleanup`만 실행할 수 있습니다.
- `--compact` 명령과 시나리오 결과는 공백 없는 한 줄 JSON으로 출력됩니다. 저장되는 보고서는 사람이 확인하기 쉽도록 들여쓰기를 유지합니다.

## 실제 화면 확인하기

GUI 디자인이나 Lore처럼 픽셀로 확인해야 하는 항목은 `visual` 세션을 사용합니다.

```powershell
minecraft-cli --compact --json visual launch visual1 `
  --host 127.0.0.1 `
  --port 25565 `
  --username VisualOne `
  --version 1.21.4 `
  --width 960 --height 540 --gui-scale 2 --fov 70

minecraft-cli --compact --json visual hover-slot visual1 --slot 10
minecraft-cli --compact --json visual screenshot visual1 --label gui-lore
minecraft-cli --compact --json visual stop visual1
```

`visual state`는 실제 적용된 framebuffer 크기, GUI scale, FOV, yaw/pitch, 1·3인칭 시점과 선택된 리소스팩을 반환합니다. 회전과 시점 변경은 Windows 입력 장치를 사용하지 않습니다.

```powershell
minecraft-cli --compact --json visual state visual1
minecraft-cli --compact --json visual rotate visual1 --yaw 180 --pitch -15
minecraft-cli --compact --json visual rotate visual1 --yaw 20 --pitch 0 --relative
minecraft-cli --compact --json visual perspective visual1 --mode third-back
```

control-mod 소스가 기존 JAR보다 새로우면 다음 `visual prepare`/`visual launch`에서 자동으로 다시 빌드합니다. 이미 실행 중인 구형 화면 세션은 hot reload되지 않으므로 `visual stop` 후 다시 실행해야 합니다. 이 경우 빈 결과나 HTML 파싱 오류 대신 `VISUAL_CONTROL_ADAPTER_STALE` 또는 `VISUAL_ROUTE_UNAVAILABLE`을 반환합니다.

Minecraft 1.21.11에서는 TextDisplay 문구와 월드 좌표, scale, seeThrough, viewRange, 화면 pixel 경계와 각도 오차를 읽고 문구로 조준·우클릭할 수 있습니다.

```powershell
minecraft-cli --compact --json visual text-displays visual1 --text "스폰 뒷편"
minecraft-cli --compact --json actor aim-text visual1 `
  --text "스폰 뒷편" `
  --min-pixel-height 12 --max-pixel-height 32 `
  --max-angular-miss 20 --expect-dialog
```

리소스팩은 visual 세션에만 복사·활성화되며 UUID, SHA-256, active 상태를 확인할 수 있습니다. `visual stop` 또는 launch 실패 시 options와 복사한 ZIP을 원복합니다.

```powershell
minecraft-cli --compact --json visual launch model-actor `
  --auth microsoft --profile ActorMinecraftName `
  --host play.example.com --port 25565 --version 1.21.11 `
  --resource-pack C:\packs\modelengine-core.zip `
  --pack-uuid modelengine-core
```

서로 다른 Microsoft visual 세션 두 개가 있으면 같은 시점을 1인칭 actor와 3인칭 observer에서 동시에 캡처합니다. 요청 시작 시각 차이는 `captureSkewMs`로 반환됩니다. 조건이 부족하면 `ACTOR_CAPABILITY_UNAVAILABLE`로 실패합니다.

```powershell
minecraft-cli --compact --json actor capture-pair model-actor `
  --observer model-observer --label sword-motion `
  --actor-perspective first --observer-perspective third-back
```

일반 화면과 다이얼로그는 먼저 표시 문구로 위젯을 찾아 클릭합니다. 버튼 문구가 없거나 커스텀 렌더링된 화면만 좌표를 사용합니다. 입력과 스크롤은 실제 키보드나 Windows 마우스를 건드리지 않고 Minecraft 내부로 전달됩니다.

```powershell
minecraft-cli --compact --json visual elements visual1
minecraft-cli --compact --json visual hover-element visual1 "확인" --exact
minecraft-cli --compact --json visual click-element visual1 "확인" --exact
minecraft-cli --compact --json visual click visual1 --x 160 --y 90
minecraft-cli --compact --json visual type-text visual1 "테스트 입력"
minecraft-cli --compact --json visual press-key visual1 tab
minecraft-cli --compact --json visual press-key visual1 enter
minecraft-cli --compact --json visual move-cursor visual1 --x 280 --y 160
minecraft-cli --compact --json visual scroll visual1 --delta -3
```

네이티브 데이터 기반 다이얼로그는 Minecraft `1.21.6`에 추가됐으므로 지원 버전 중에서는 `1.21.11`에서만 검사할 수 있습니다. `1.20.1`과 `1.21.4`의 플러그인 GUI나 커스텀 화면은 같은 위젯·좌표·키 입력 API로 검사합니다.

NPC와 다이얼로그를 한 흐름에서 다룰 때는 `actor` 명령을 사용합니다. 연결된 화면 세션을 우선 사용하고, NPC 상호작용은 필요하면 같은 이름의 headless 세션으로 대체합니다. 지원되지 않는 기능은 건너뛰지 않고 capability 오류로 반환합니다.

```powershell
minecraft-cli --compact --json actor capabilities visual1
minecraft-cli --compact --json actor interact-role visual1 --role "상점 NPC"
minecraft-cli --compact --json actor actions visual1
minecraft-cli --compact --json actor click-action visual1 --action-id button:2
```

1.21.11 native Dialog에서는 중첩 layout의 실제 사용자 버튼이 안내 버튼보다 먼저 반환됩니다. 사용자 버튼은 `dialog:0`, `dialog:1`처럼 안정적인 action ID와 text/bounds를 가지며, `click-action`은 좌표 클릭 대신 버튼의 실제 `onPress` callback을 호출합니다. 결과의 `callbackInvoked: true`로 전송 여부를 확인할 수 있습니다.

```powershell
minecraft-cli --compact --json actor actions visual1
minecraft-cli --compact --json actor click-action visual1 --action-id dialog:0
```

실제 회귀 예제는 `fixtures/scenarios/npc-dialog-action.json`에 있습니다.

`visual state`는 지원 클라이언트의 dimension과 현재 좌표도 반환합니다. 따라서 같은 화면 클라이언트에서 NPC를 누르고 캐릭터를 선택한 뒤 마지막 위치가 복원됐는지 JSON으로 비교할 수 있습니다.

Arvella 개발용 시나리오와 필요한 capability는 `fixtures/scenarios/arvella`와 `fixtures/scenarios/arvella-world`에 분리되어 있습니다. 이 파일들은 `codex/arvella-dev` 브랜치에서만 관리합니다.

화면 클라이언트는 MultiMC에 이미 로그인된 기본 계정을 그대로 사용할 수 있습니다.

```powershell
minecraft-cli --compact --json visual launch visual-ms `
  --auth microsoft `
  --host play.example.com `
  --port 25565 `
  --version 1.21.4
```

MultiMC에 계정이 여러 개라면 `--profile MyMinecraftName`을 추가해 사용할 계정을 지정합니다.

`auth login`으로 저장한 Mineflayer 인증과 MultiMC 계정은 서로 별개입니다. 헤드리스 `session`은 계정 별칭을 사용하고, 실제 화면을 띄우는 `visual`은 MultiMC에서 선택된 계정을 사용합니다.

관리형 MultiMC 인스턴스에는 다음 규칙이 적용됩니다.

- 필요한 슬롯만 만들며 버전마다 최대 8개까지 사용할 수 있습니다.
- 같은 버전의 화면 클라이언트도 동시에 실행할 수 있습니다.
- 종료된 슬롯을 우선 재사용하므로 실행 횟수에 따라 인스턴스가 계속 늘어나지 않습니다.
- 인스턴스는 MultiMC의 `minecraft-cli` 그룹에 자동으로 정리됩니다.
- 실행할 때마다 Minecraft 마스터 볼륨을 `0`으로 맞춥니다.
- 세션별 제어 포트, 인증 토큰, 결과 폴더를 따로 사용합니다.

구버전이 미리 만든 빈 슬롯은 한 번만 정리하면 됩니다.

```powershell
minecraft-cli --json visual prune
```

두 화면 세션을 함께 실행하는 예시는 다음과 같습니다.

```powershell
minecraft-cli --json visual launch visual-a --host 127.0.0.1 --port 25565 --username VisualA --version 1.21.4
minecraft-cli --json visual launch visual-b --host 127.0.0.1 --port 25565 --username VisualB --version 1.21.4
```

## 테스트 결과

JSON, 메타데이터, 스크린샷은 테스트 중인 프로젝트 안에 세션별로 저장됩니다.

```text
.minecraft-cli/
└─ sessions/
   └─ <세션 이름>/
      ├─ json/
      ├─ screenshots/
      ├─ events.jsonl
      └─ visual-client.json
```

상태 전체를 매번 읽기보다 필요한 부분만 요청하면 출력이 짧고 처리도 빠릅니다.

```powershell
minecraft-cli --compact --json session state bot1 --part core
minecraft-cli --compact --json session state bot1 --part window
minecraft-cli --compact --json session state bot1 --part ui
minecraft-cli --compact --json session state bot1 --part hud
```

여러 상태를 기준선 하나로 묶어 바뀐 필드, 슬롯, 이벤트만 받을 수 있습니다.

```powershell
minecraft-cli --compact --json session checkpoint bot1 --label before --parts core,window,ui,hud,entities,inventory,events
minecraft-cli --compact --json session diff bot1 --baseline before
minecraft-cli --compact --json session checkpoint-delete bot1 --label before
```

인벤토리는 빈 칸을 포함한 전체 슬롯과 아이템 메타데이터를 체크포인트로 저장하고 정확히 비교할 수 있습니다.

```powershell
minecraft-cli --compact --json session inventory-checkpoint bot1 --label before
minecraft-cli --compact --json session compare-inventory bot1 --baseline .minecraft-cli/sessions/bot1/json/<checkpoint>.inventory.json
```

프록시 또는 서버의 `/transfer` 전에는 이벤트 응답의 `nextSequence`를 기록하고, 이동 뒤 연결과 목적지 정보를 함께 확인합니다.

```powershell
minecraft-cli --compact --json session expect-transition bot1 --after 42 --brand Paper --timeout-ticks 200
```

이벤트를 반복 조회할 때는 응답의 `nextSequence`를 기억하고 다음 요청에 넘깁니다. 이미 읽은 채팅과 UI 이벤트가 다시 출력되지 않습니다.

```powershell
minecraft-cli --compact --json session events bot1 --limit 20
minecraft-cli --compact --json session events bot1 --after 42 --limit 20
```

`message`와 그 문자열 별칭은 하나의 이벤트로 합쳐 저장하며, 의미가 같은 타이틀·보스바·스코어보드 원본 패킷도 중복 기록하지 않습니다.

`visual screenshot`은 같은 세션의 직전 PNG와 자동 비교합니다. GUI, Lore tooltip, 채팅, 다이얼로그, HUD의 관심 영역과 실제 변화 영역이 겹치는 부분만 crop으로 저장하며, 변화가 없으면 crop을 만들지 않습니다.

```powershell
minecraft-cli --compact --json visual screenshot visual1 --label menu --region gui
minecraft-cli --compact --json visual screenshot visual1 --label dialog --region dialog --contact-sheet
```

작은 글자, Lore, 색상처럼 미세한 차이가 테스트 대상이면 변화 판정과 관계없이 PNG를 직접 확인해야 합니다. 비교가 필요 없는 캡처에는 `--no-compare`를 사용할 수 있습니다.

Codex에서는 함께 설치되는 `$minecraft-plugin-test` Skill이 이 흐름과 명령을 사용할 수 있습니다.

## 선택형 Paper Probe

격리된 테스트 서버에는 `fixtures/paper-probe`의 Probe를 선택 설치할 수 있습니다. join/quit, 명령, 인벤토리, 채팅, 상호작용, 이동·사망과 플러그인 예외를 assertion용 구조로 관측하고 테스트 상태를 제한적으로 복원합니다. Probe가 없으면 오류 대신 `available: false`로 정상 저하됩니다.

```powershell
minecraft-cli --compact --json probe status
minecraft-cli --compact --json probe events --after 0 --limit 20
minecraft-cli --compact --json probe diagnostics
```

Probe는 `.minecraft-cli` 테스트 서버 전용이며 운영 서버나 서버팩에 등록하지 않습니다.

## 결과 파일 관리

저장 용량은 데몬을 시작하지 않고 확인할 수 있습니다.

```powershell
minecraft-cli --compact --json artifacts status
minecraft-cli --compact --json artifacts prune --older-than-days 30
```

`artifacts prune`은 기본적으로 미리보기만 하고 보고서를 `.minecraft-cli/runs`에 저장합니다. 실제 삭제에는 `--apply`가 반드시 필요합니다.

```powershell
minecraft-cli --compact --json artifacts prune --older-than-days 30 --apply
```

세션별 최신 스크린샷 20개, 명시 저장 JSON 50개와 최신 시나리오 보고서 50개는 기본적으로 항상 보존됩니다. `metadata.json`, `visual-client.json`, `latest-*`, 이벤트 로그, 런타임과 다운로드는 삭제 대상이 아닙니다.

## 더 보기

- [세션 파일 구조](docs/session-artifacts.md)
- [시나리오 예제](docs/scenario.example.json)
- [구현 구조](docs/architecture.md)
- [검증 결과](docs/visual-validation-report.md)
- [Arvella World와 ModelEngine 검증](docs/world-camera-e2e.md)
