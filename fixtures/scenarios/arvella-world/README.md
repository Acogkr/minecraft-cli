# Arvella World / ModelEngine E2E

- `world-textdisplay-camera.json`: 연결된 1.21.11 visual 세션에서 워프 TextDisplay 크기, 각도, 선택 범위와 Dialog 개방을 검사합니다.
- `character-logout-dialog.json`: 로그아웃 Dialog의 중첩 사용자 버튼을 읽고 `저장하고 로그아웃` callback을 실행합니다.
- `modelengine-pack-off.json`: core shader 리소스팩이 없는 1인칭 actor/3인칭 observer 증거를 남깁니다.
- `modelengine-pack-on.json`: 같은 모션을 session-only pack 적용 상태로 캡처하고 종료 시 원복합니다.

실행 전 JSON의 서버 주소, MultiMC profile 이름, 테스트 명령, 리소스팩 ZIP 경로를 격리 E2E 값으로 바꿉니다. 두 ModelEngine 시나리오는 서로 다른 Microsoft 계정이 등록된 두 profile이 필요하며, 없으면 `ACTOR_CAPABILITY_UNAVAILABLE`이 정상 결과입니다.

픽셀 크기는 실제 framebuffer와 FOV, TextDisplay transformation scale을 사용한 client-side projection 값입니다. PNG는 최종 디자인 확인에 사용하고 JSON은 크기·각도 회귀의 결정적 assertion에 사용합니다.
