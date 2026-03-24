# Claude Code 환경 설정 복원 가이드

노트북 포맷 후 현재 Claude Code 설정을 그대로 복원하기 위한 가이드입니다.
이 파일을 새 클로드에게 전달하면 자동으로 셋업합니다.

---

## 1단계: Claude Code 설치

```bash
# Node.js 설치 (homebrew)
brew install node

# Claude Code 설치
npm install -g @anthropic-ai/claude-code

# uv 설치 (MCP 서버용 Python 패키지 매니저)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

---

## 2단계: 설정 파일 복원

### 2-1. `~/.claude/settings.json`

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "WebFetch(*)",
      "WebSearch(*)",
      "NotebookEdit(*)",
      "TodoWrite(*)",
      "Agent(*)",
      "mcp__n8n__*",
      "mcp__mssql__*",
      "mcp__kis__*",
      "mcp__dart__*",
      "mcp__stock-news__*",
      "mcp__stock-market__*"
    ],
    "additionalDirectories": [
      "/tmp",
      "/Users/kakao/Library/LaunchAgents"
    ]
  }
}
```

### 2-2. `~/.claude/CLAUDE.md`

글로벌 개발 원칙 파일입니다. 현재 프로젝트의 `CLAUDE.md`와 동일한 내용이 `~/.claude/CLAUDE.md`에 위치합니다.
내용이 길어서 여기에 포함하지 않습니다. **현재 `~/.claude/CLAUDE.md` 파일을 백업해두세요.**

핵심 내용:
- 데이터 기반 개발, 기획 우선, 전체 점검 원칙
- 팀 에이전트 자동 판단 규칙 (개발팀/리뷰팀/장애팀/백테팀/기획팀/UI팀/QA팀/투자팀)
- 팀별 인원 명부 및 진행률 보고 형식
- Google Sheets API 접근 방법
- 코드 품질 및 안전 우선 원칙

### 2-3. `~/.claude/mcp.json` (MCP 서버 설정)

```json
{
  "mcpServers": {
    "kis": {
      "command": "/Users/kakao/.local/bin/uv",
      "args": [
        "run",
        "--project", "/Users/kakao/.claude/KIS_MCP_Server",
        "python",
        "/Users/kakao/.claude/KIS_MCP_Server/server.py"
      ],
      "env": {
        "KIS_APP_KEY": "<KIS_APP_KEY>",
        "KIS_APP_SECRET": "<KIS_APP_SECRET>",
        "KIS_ACCOUNT_TYPE": "REAL",
        "KIS_CANO": "<계좌번호>"
      }
    },
    "dart": {
      "command": "/Users/kakao/.local/bin/uv",
      "args": [
        "run",
        "--project", "/Users/kakao/.claude/DART_MCP_Server",
        "python",
        "/Users/kakao/.claude/DART_MCP_Server/server.py"
      ],
      "env": {
        "DART_API_KEY": "<DART_API_KEY>"
      }
    },
    "stock-news": {
      "command": "/Users/kakao/.local/bin/uv",
      "args": [
        "run",
        "--project", "/Users/kakao/.claude/StockNews_MCP_Server",
        "python",
        "/Users/kakao/.claude/StockNews_MCP_Server/server.py"
      ],
      "env": {
        "NAVER_CLIENT_ID": "<NAVER_CLIENT_ID>",
        "NAVER_CLIENT_SECRET": "<NAVER_CLIENT_SECRET>"
      }
    },
    "stock-market": {
      "command": "/Users/kakao/.local/bin/uv",
      "args": [
        "run",
        "--project", "/Users/kakao/.claude/StockMarket_MCP_Server",
        "python",
        "/Users/kakao/.claude/StockMarket_MCP_Server/server.py"
      ]
    }
  }
}
```

> **API 키는 별도로 안전하게 보관하세요.** 위 `<placeholder>`를 실제 값으로 교체해야 합니다.

---

## 3단계: MCP 서버 복원

현재 `~/.claude/` 폴더에 4개의 MCP 서버 프로젝트가 있습니다:

```
~/.claude/KIS_MCP_Server/       # 한국투자증권 API
~/.claude/DART_MCP_Server/      # DART 전자공시
~/.claude/StockNews_MCP_Server/ # 네이버 뉴스 검색
~/.claude/StockMarket_MCP_Server/ # 시장 데이터
```

**이 4개 폴더를 통째로 백업하세요.** 포맷 후 `~/.claude/` 아래에 동일 경로로 복원하면 됩니다.

각 MCP 서버에 Python 의존성 설치:
```bash
cd ~/.claude/KIS_MCP_Server && uv sync
cd ~/.claude/DART_MCP_Server && uv sync
cd ~/.claude/StockNews_MCP_Server && uv sync
cd ~/.claude/StockMarket_MCP_Server && uv sync
```

---

## 4단계: 커스텀 스킬 복원

`~/.claude/skills/` 폴더에 11개의 팀 에이전트 스킬이 있습니다:

| 파일명 | 설명 |
|--------|------|
| `개발팀.md` | 개발+영향도분석 2인 팀 |
| `리뷰팀.md` | 보안/로직/품질 3인 코드 리뷰 팀 |
| `장애팀.md` | 장애 분석 2인 팀 (root cause + 전수 점검) |
| `백테팀.md` | 백테스트 분석 3인 팀 |
| `기획팀.md` | 기획 검토 3인 팀 (설계/반론/현실성) |
| `UI팀.md` | UI/UX 검증 3인 팀 |
| `QA팀.md` | 최종 검증 3인 팀 |
| `분석팀.md` | 기술적분석+보조지표+펀더멘탈 3인 팀 |
| `전략팀.md` | 퀀트+리스크+백테스트 3인 팀 |
| `시장팀.md` | 매크로+섹터 2인 팀 |
| `종목분석.md` | 분석팀+전략팀+시장팀 종합 종목 분석 |

**`~/.claude/skills/` 폴더를 통째로 백업하세요.**

---

## 5단계: 프로젝트 복원

```bash
# GitHub에서 프로젝트 클론
git clone https://github.com/haesam5060-arch/bunt24.git ~/Desktop/project/24번트

# 의존성 설치
cd ~/Desktop/project/24번트
npm install

# config.json 복원 (API 키 포함이라 git에 안 올라감)
# data/config.json을 별도 백업에서 복원하세요
```

---

## 백업 체크리스트

포맷 전에 반드시 백업할 파일/폴더:

```
[ ] ~/.claude/CLAUDE.md                    # 글로벌 개발 원칙
[ ] ~/.claude/settings.json                # 권한 및 환경변수 설정
[ ] ~/.claude/mcp.json                     # MCP 서버 설정
[ ] ~/.claude/skills/                      # 커스텀 스킬 11개 (폴더 전체)
[ ] ~/.claude/KIS_MCP_Server/              # KIS MCP 서버 (폴더 전체)
[ ] ~/.claude/DART_MCP_Server/             # DART MCP 서버 (폴더 전체)
[ ] ~/.claude/StockNews_MCP_Server/        # 뉴스 MCP 서버 (폴더 전체)
[ ] ~/.claude/StockMarket_MCP_Server/      # 시장 MCP 서버 (폴더 전체)
[ ] ~/Desktop/project/24번트/data/config.json  # 업비트 API 키 + 전략 설정
```

### API 키 별도 메모 (안전한 곳에 보관)
- 업비트 accessKey / secretKey
- KIS APP_KEY / APP_SECRET / 계좌번호
- 네이버 CLIENT_ID / CLIENT_SECRET
- DART API_KEY
- Gmail 앱 비밀번호

---

## 새 클로드에게 전달하는 방법

1. 위 백업 파일들을 새 노트북의 동일 경로에 복원
2. Claude Code 설치 후 아무 프로젝트에서 실행
3. 자동으로 `~/.claude/` 의 설정을 읽어서 기존과 동일하게 동작

**또는** 이 파일을 새 클로드에게 보여주고 "이 가이드대로 셋업해줘"라고 하면 됩니다.
