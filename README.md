# 射龍門

規格見 [SPEC.md](SPEC.md)。需要 Node.js ≥ 22.18（直接執行 TypeScript，無需編譯）。

```bash
npm install
npm test            # 引擎、房間、WebSocket 端對端測試
npm start           # http://localhost:3000（改程式後需重啟）
npm run dev         # 開發用：改程式會自動重啟伺服器（狀態存檔會恢復進行中的牌局）
npm run rwd         # 用本機 Chrome 以多種手機/平板/桌面寬度實測橫向捲動（含翻牌動畫期間）；可加截圖目錄參數
npm run stability   # 用本機 Chrome 檢查「輪到誰」那一區在各種狀態下位置完全不動（不會跳動）
```

| 目錄 | 內容 |
|---|---|
| `src/engine/` | Phase 1：牌組、判定、遊戲規則（純邏輯） |
| `src/server/rooms.ts` | Phase 2：房間、密碼、房主、剔除、電腦玩家、操作驗證、持久化 |
| `src/draw/` | 臨摹大賽（第二款遊戲）：`scoring.ts` 相似度裁判、`rooms.ts` 房間與流程、`hub.ts` WebSocket（`/ws/draw`）；`refs/*.json` 是各張名畫的比對資料，用 `npm run drawref` 重新產生 |
| `src/server/server.ts` | Phase 3/5：WebSocket、30 秒計時、離線代打、cookie 重連、狀態存檔 |
| `public/` | 尾牙首頁（`index.html`，一頁式，點羊進大廳）、遊戲大廳 `public/lobby/`、共用樣式 `home.css`；`public/gate/` 是射龍門遊戲（手機優先 RWD 介面），網址 `/gate/` |

## 環境變數
- `PORT`（預設 3000）、`STATE_FILE`（預設 `data/state.json`）
- `COOKIE_SECURE=1`：在 HTTPS（ALB）後方時啟用 Secure cookie

## 部署到 AWS 的注意事項
- 房間狀態在**單一行程記憶體**內，並定期存到 `STATE_FILE`。目前請只跑 **1 個實例**（ECS/Fargate desired count = 1 或單台 EC2）。
- 前面接 ALB：啟用 WebSocket（HTTP/HTTPS listener 原生支援）、idle timeout 設 ≥ 120 秒，Health check 路徑 `/healthz`。
- 若要水平擴充，需把 `RoomManager` 狀態移到 Redis（ElastiCache）並以 roomId 做 sticky routing；`toJSON()/load()` 已提供序列化邊界。
- 容器重啟時，`STATE_FILE` 需放在持久化磁碟（EFS 或 EBS），否則進行中的牌局會遺失。
