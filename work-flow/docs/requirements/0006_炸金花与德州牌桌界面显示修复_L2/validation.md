task_id: 0364b845-9125-4a30-a55d-938e02c3043a
validation: passed

- Vitest 全量 `npm run test:run`：29 个文件、200 项测试，198 通过。`tests/blackbox.test.js` 的 2 项因 `afterEach` 关闭运行时超时（10s）与随后的 ECONNREFUSED 级联失败；单独运行 `npx vitest run tests/blackbox.test.js` 为 6/6 通过、67.5s，属并发负载抖动，与本次改动无关。
- 契约单测 `tests/client-contract.test.js` 与 `tests/texas-client-contract.test.js`：13/13 通过，`function projectSeats`、`@media(max-width:620px)`、卡面与座位选择器等断言均保持。
- Playwright（Edge 通道）`e2e/gameplay.spec.js` + `e2e/texas-animations.spec.js`：9/9 通过，覆盖 2/3/6 人与观战视图、座位不越界不重叠、南向自座、德州缩放方向与列内裁切。
- 几何实测（6 人、24 字昵称，Playwright + Edge 对 3299 端口实例）：
  - 炸金花座位余量由负值（座位越出桌沿）改善为各视口桌内 +7 至 +15px；最差座位重叠由 36×37px 变为无重叠；被截断昵称由 6 个变 0 个（`nameNeeded === nameShown`）。
  - 2/3/4/6 人 × {1280×720, 390×844} 八种组合均为 `inside:true, overlaps:0, seatsOverCenter:0`。
  - 德州四个桌面视口 `pageOverflow` 为 0，座位余量 +12 至 +19px，`cardsOverCenter` 与 `labelsClipped` 均为 0。
- 椭圆裁切复核：桌面由 `border-radius:50%` 改为圆角矩形后，上沿对手座位的四角不再落在裁切区外，截图确认头像与手牌完整。
- 移动端 390×844 仍有整页滚动（炸金花 406px、德州 443px），为移动端单列堆叠的既有设计，`body` 为 `overflow-y:auto`，牌桌本身完整显示、无裁切、无压住底池，非本次缺陷。
