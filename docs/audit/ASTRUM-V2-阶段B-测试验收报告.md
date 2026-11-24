# ASTRUM V2 阶段 B 测试验收报告

## 一、测试环境

- 操作系统：Windows
- Node.js：v24.19.0
- 浏览器实测：本机 Chrome（`tools/p4-browser-test.js` 自动探测）
- 仓库：`D:\Projects\Astrum`
- 分支/HEAD：`main` / `5dd6d64`
- 存储后端：IndexedDB（fake-idb 单元测试 + 真实 Chrome 刷新测试）；localStorage/memory 回退由 P4S-31/32/33 覆盖
- 网络：未配置 `ASTRUM_LIVE_API_KEY`，真实 Provider 用例按设计标记 `BLOCKED_API_KEY`

## 二、测试命令与结果

### 2.1 阶段 A 基线回放

| 命令 | 结果 | 说明 |
|---|---|---|
| `node tools/selftest.js` | **157/157 PASS** | CSP 违规 0 |
| `node tools/p0-security-test.js` | **38/38 PASS** | 授权、Profile 隔离、ToolGateway |
| `node tools/p0-03-test.js` | **53/53 PASS** | 旧 checks/sections 契约 |
| `node tools/p4-browser-test.js` | **13/13 PASS** | 真实 Chrome 刷新恢复，IndexedDB 后端 |
| `node tools/v1-5-perf-test.js` | 基线输出 | 无 PASS/FAIL 门槛，记录性能 |
| `node tools/v2-sky-01-test.js` | **52/52 PASS** | 星图图层/模型 |
| `node tools/v2-sky-2b-test.js` | **31/31 PASS** | L1 星场 |
| `node tools/v2-sky-2c-test.js` | **24/24 PASS** | 银河背景 |
| `node tools/visual-stars-test.js` | **16/16 PASS** | 恒星视觉参数 |
| `node tools/visual-stars-quality-test.js` | **36/36 PASS** | 星表质量与真实数据 |

性能基线（本地 Node，非验收门槛）：

- cold load 113.12 ms
- router p95 1.09 ms
- planner p95 0.98 ms
- controlLocal avg 27.02 ms
- taskStore200 156.56 ms
- heapUsed 15.38 MB

### 2.2 全量非浏览器套件

对 `tools/*test*.js` 中除 `*browser*`、`v1-5-longrun-test.js`、`v1-5-perf-test.js` 外的套件逐一执行：

- 套件总数：**117**
- PASS：**114**
- FAIL：**0**
- BLOCKED：**3**（均为缺少真实 Provider Key，非代码回归）
  - `v1-6-provider-test.js` → `BLOCKED_API_KEY`
  - `v1-9-provider-test.js` → `RESULT 21/21`，真实调用 `BLOCKED_API_KEY`
  - `v1-9-real-provider-integration-test.js` → `BLOCKED_API_KEY`
- NOT RUN：0

### 2.3 新增独立测试集合

| 测试文件 | 覆盖 | 结果 |
|---|---|---|
| `tools/v2-timeout-abort-test.js` | 正常完成、超时 abort、完成不误判、用户取消、超时后不启动下一步、并行取消、重复取消、已完成不误标、不可中断边界、完成/超时竞态、取消/超时竞态、上游取消+下游错误、无未处理 rejection | **17/17 PASS** |
| `tools/v2-task-pause-resume-test.js` | 空闲暂停、在飞暂停、不可中断步骤安全边界、并行暂停、暂停请求不分发新步骤、持久化失败不伪造 PAUSED、刷新后恢复、不重跑已完成、取消后不可恢复、暂停/取消抢占、重复暂停 | **21/21 PASS** |
| `tools/v2-idempotency-recovery-test.js` | 上下文一致复用、参数/工具版本/Skill 版本/Profile/上下文变化不复用、授权撤销、未持久化、哈希不符、有副作用不自动重跑、崩溃后外部状态未知、未开始可重跑、重复恢复稳定、结果不完整、plan/apply 一致 | **16/16 PASS** |
| `tools/v2-multi-tab-concurrency-test.js` | 单写、并发同修订恰一成功、首次并发、并发事件追加、冲突后重读重放、不同任务并发、不同 Profile 隔离、事务中断无部分写、DB 版本、历史无 revision、导入旧格式、updatedAt 兜底 | **17/17 PASS** |
| `tools/v2-b-joint-test.js` | 超时+暂停、暂停+多标签、恢复+幂等、取消+持久化失败、运行中暂停两阶段 | **12/12 PASS** |
| `tools/v2-external-call-recovery-test.js` | executionId 唯一、idempotencyKey 跨重试稳定、回执持久化、非幂等外部调用成功复用/失败重跑/未知确认、UNKNOWN 外部回执校验、直接 decide 不绕过 | **12/12 PASS** |
| `tools/v2-abortable-tools-test.js` | R-01/R-02：工具 abortable 声明、signal 贯穿 fetch、预取消零请求、在飞取消中止 fetch、取消不重试、取消不计入熔断、暂停/用户取消语义、paper 全文 signal、compose 预取消 | **13/13 PASS** |
| `tools/v2-recovery-confirmation-test.js` | R-03：`rerun/reuse/abandon` 三动作、状态与错误迁移、事件、重复恢复不翻转、rerun 一次性标记、权限拒绝、非法决策、非确认态、CAS 冲突、bridge 透传 | **17/17 PASS** |
| `tools/v2-localstorage-cas-test.js` | R-04：Web Locks 跨标签互斥、并发 CAS 恰一成功一 STALE、不同任务互不抹除、无锁降级标记、owner 命名空间隔离、锁异常释放 | **11/11 PASS** |

新增合计：**136/136 PASS**。

### 2.4 既有 V2/P3/P4 专项套件

| 命令 | 结果 |
|---|---|
| `node tools/p3-executor-test.js` | **17/17 PASS** |
| `node tools/v2-pause-test.js` | **14/14 PASS** |
| `node tools/p4-idempotency-test.js` | **18/18 PASS** |
| `node tools/v2-recovery-idempotency-test.js` | **11/11 PASS** |
| `node tools/v2-occ-test.js` | **8/8 PASS** |
| `node tools/p4-store-test.js` | **34/34 PASS** |

## 三、故障注入结果

- 超时：可控慢工具记录到 `AbortSignal`，收到 abort 后执行清理并返回可识别终止结果（V2-ABORT-03）。
- 不可中断工具：`abortable:false`，超时记录 `ABORT_UNSUPPORTED`、`abortConfirmed=false`（V2-ABORT-13）。
- 暂停：不接收 signal 的工具继续执行到安全边界，完成后才允许 PAUSED（V2-PR-08/09）。
- 持久化失败：`store.save` 注入 `PERSIST_TX_FAILED`，暂停返回 `PAUSE_PERSIST_FAILED`，内存不保留 `pausedAt`（V2-PR-15/16）；取消路径返回 `persistFailed=true` 且不伪造已落盘（V2-JOINT-08/09）。
- 事务中断：`abortNextTransaction()` 注入，revision 不变、无部分写入（V2-MT-10/11）。
- 配额：沿用 P4S-20/21，`QUOTA_EXCEEDED` 且不删除当前任务。
- 外部调用：注入 `receipt / externalState`，验证成功复用、失败重跑、无回执确认；并验证重试复用同一 `idempotencyKey`、`executionId` 每次唯一（V2-EXT-01~12）。

## 四、并发测试结果

- 两个标签页同时基于 revision 1 保存：恰一个成功，另一个 `STALE_WRITE`，最终 revision 只 +1（V2-MT-02/03/04）。
- 首次并发保存（expectedRevision 0）：仅一个成功（V2-MT-05）。
- 并发追加事件：单写成功；失败方重读后重放成功，seq 单调（V2-MT-06/07）。
- 不同 Task、不同 Profile 并发：均成功且相互隔离（V2-MT-08/09）。
- 暂停与恢复跨标签：旧修订恢复被拒绝，重读后仅一个终态（V2-JOINT-03/04）。
- 页面关闭等价注入：事务中断无部分写入（V2-MT-10/11）。

## 五、浏览器实测结果

`node tools/p4-browser-test.js` 使用真实 Chrome + `file://`：

- 真实后端为 IndexedDB
- 刷新后任务仍在列表、可恢复、检查点可读
- 恢复入口出现，恢复后幂等步骤不重跑，待办步骤执行
- 恢复后进入终态，不再可恢复，恢复事件已记录

13/13 PASS。

阶段 B 新增的暂停按钮端到端 UI 点击流程已由 `tools/v2-pause-browser-test.js` 覆盖（15/15 PASS，见第十一节）；`p4-browser-test.js` 仍覆盖刷新/恢复的 IndexedDB 路径。

## 六、原有回归与解释

- 原有测试未删除、未降低断言。
- `p4-idempotency-test.js` 与 `v2-recovery-idempotency-test.js` 的预期由“未知凭证失败 → block”收紧为“→ confirm/等待人工确认”，属于安全性提升，非放宽。
- 3 个 Provider 套件因缺少本机 Key 标记 BLOCKED，与阶段 B 改动无关。
- `i18n-scan.js --max=0`：UI 0 条，基线检查通过（exit 0）。

## 七、统计汇总

| 类别 | PASS | FAIL | BLOCKED | NOT RUN |
|---|---:|---:|---:|---:|
| 阶段 A 必跑基线 | 157 + 38 + 53 + 13 + 52 + 31 + 24 + 16 + 36 | 0 | 0 | 0 |
| 全量非浏览器套件 | 114 个套件 | 0 | 3 | 0 |
| 新增独立测试 | 108 | 0 | 0 | 0 |
| 既有 V2/P3/P4 专项 | 102 | 0 | 0 | 0 |

> 注：不同套件断言数不可简单相加；“既有专项 102”为 17+14+18+11+8+34。

## 八、R-01 / R-02 修复后的追加验证（2026-11-23）

修复内容：`core/sources.js` 的检索链路全链路贯穿 signal；`core/registry.js` 将 `evidence.search`、`paper.search`、`llm.compose` 改为 `abortable:true` 并传递 `runtime.signal`；取消/暂停映射为 `pendingAbort + pause + abortCode`，取消不再计入端点熔断。

本次实跑结果：

| 套件 | 结果 |
|---|---|
| `tools/v2-abortable-tools-test.js`（新增） | **13/13 PASS** |
| `tools/v2-timeout-abort-test.js` | **17/17 PASS** |
| `tools/v2-task-pause-resume-test.js` | **21/21 PASS** |
| `tools/v2-recovery-idempotency-test.js` | **11/11 PASS** |
| `tools/v2-idempotency-recovery-test.js` | **16/16 PASS** |
| `tools/v2-multi-tab-concurrency-test.js` | **17/17 PASS** |
| `tools/v2-external-call-recovery-test.js` | **12/12 PASS** |
| `tools/v2-b-joint-test.js` | **12/12 PASS** |
| `tools/p4-idempotency-test.js` | **18/18 PASS** |
| `tools/p0-security-test.js` | **38/38 PASS** |
| `tools/p0-03-test.js` | **53/53 PASS** |
| `tools/p4-browser-test.js` | **13/13 PASS** |
| `tools/p3-integration-test.js` | **9/9 PASS** |
| `tools/control-test.js` | **86/86 PASS** |
| `tools/research-test.js` | **77/77 PASS（离线 mock）** |
| `tools/b8-test.js` | **33/33 PASS** |
| `tools/p1-resume-test.js` | **42/42 PASS** |
| `tools/v2-sky-01-test.js` | **52/52 PASS** |
| `tools/v2-sky-2b-test.js` | **31/31 PASS** |
| `tools/v2-sky-2c-test.js` | **24/24 PASS** |
| `tools/visual-stars-test.js` | **16/16 PASS** |
| `tools/visual-stars-quality-test.js` | **36/36 PASS** |
| `tools/selftest.js` | **156/157**，1 条失败为 `ip locate chain works`：本机直连 `ipwho.is` 失败（网络层拒绝），与本次改动无关；其余 156 条通过 |

结论：R-01/R-02 中「网络检索与合成链路可中断」部分已闭环；`kepler.*`、`kb.lookup`、`fits.parse`、`compare.curate`、`compose.*` 等本地同步计算仍为固有边界，已在剩余风险清单中保留说明。

## 九、R-03 修复后的追加验证（2026-11-24）

修复内容：`core/recovery.js` 尊重 `provenance.recoveryConfirmation` 人工决策并避免重复恢复翻转；`core/task.js` 新增 `task.recovery_confirmed` 事件；`core/control.js` 新增 `confirmRecovery(taskId, stepId, decision)`（`rerun/reuse/abandon`，经 `task.resume` 授权、CAS 落盘、追加事件）；`core/control-bridge.js` 透传；`core/app.js` 待审批卡片增加确认动作按钮。

本次实跑结果：

| 套件 | 结果 |
|---|---|
| `tools/v2-recovery-confirmation-test.js`（新增） | **17/17 PASS** |
| `tools/v2-idempotency-recovery-test.js` | **16/16 PASS** |
| `tools/v2-recovery-idempotency-test.js` | **11/11 PASS** |
| `tools/v2-b-joint-test.js` | **12/12 PASS** |
| `tools/v2-external-call-recovery-test.js` | **12/12 PASS** |
| `tools/v2-abortable-tools-test.js` | **13/13 PASS** |
| `tools/v2-timeout-abort-test.js` | **17/17 PASS** |
| `tools/v2-task-pause-resume-test.js` | **21/21 PASS** |
| `tools/v2-multi-tab-concurrency-test.js` | **17/17 PASS** |
| `tools/p4-idempotency-test.js` | **18/18 PASS** |
| `tools/control-test.js` | **86/86 PASS** |
| `tools/p0-security-test.js` | **38/38 PASS** |
| `tools/p3-executor-test.js` | **17/17 PASS** |
| 全量 `tools/*test.js` | 核心套件全部 PASS；`geotest.js`、`v1-3-paper-fulltext-test.js`、`v2-sky-01-browser-test.js` 在全量并发中出现偶发失败，单独重跑均 PASS（外部网络/浏览器并发环境性）；provider 相关 `exit=2` 为密钥缺失的预期 `BLOCKED_API_KEY` |

结论：R-03 已从「只有等待状态」闭环为「状态 + 显式动作 + 审计事件 + UI 入口」。确认动作仍以用户判断为最终依据，系统不独立核验远端真实状态（保留 R-06b）；确认入口目前只在恢复卡片，步骤详情面板未单独提供。

## 十、R-04 修复后的追加验证（2026-11-24）

修复内容：`core/task-store.js` 的 localStorage 后端把 read→compare→write 包进 Web Locks（按 owner 命名空间命名锁），Web Locks 不可用时退化为单上下文同步段并在 `getHealth()` 标记 `crossTabAtomic=false / lockMode='same-context-only'`；锁回调异常统一转 rejection 以保证锁释放。

本次实跑结果：

| 套件 | 结果 |
|---|---|
| `tools/v2-localstorage-cas-test.js`（新增） | **11/11 PASS** |
| `tools/v2-multi-tab-concurrency-test.js` | **17/17 PASS** |
| `tools/v2-occ-test.js` | **8/8 PASS** |
| `tools/p4-store-test.js` | **34/34 PASS** |
| `tools/p4-idempotency-test.js` | **18/18 PASS** |
| `tools/p4-lifecycle-test.js` | **18/18 PASS** |
| `tools/p4-recovery-test.js` | **28/28 PASS** |
| `tools/p4-migration-test.js` | **19/19 PASS** |
| `tools/task-test.js` | **73/73 PASS** |
| `tools/v2-recovery-confirmation-test.js` | **17/17 PASS** |
| `tools/v2-idempotency-recovery-test.js` | **16/16 PASS** |
| `tools/control-test.js` | **86/86 PASS** |

结论：localStorage 降级路径在 Web Locks 可用时具备跨标签页原子 CAS，并发保存同一任务恰一成功一 `STALE_WRITE`，不同任务并发保存互不抹除；无 Web Locks 时明确不伪造跨标签保证。memory 后端不跨上下文共享，作为边界保留；跨浏览器/跨设备 CAS 仍需 IDB 或服务端，不在本阶段范围。

## 十一、R-07 修复后的追加验证（2026-11-24）

修复内容：`core/control.js` 的 `run()` 新增 `onTask(id, state)` 观察者，让运行中 UI 在事件批次发出前拿到真实 taskId；`core/control-bridge.js` 暴露 `pause(taskId, opts)`（含 principal/store 与 profile 归属校验）、透传 `onTask`、并把 `paused/pauseRequested` 从 control 结果透传给 UI；`core/app.js` 的 `controlAnswer()` 在「取消」旁新增「暂停」按钮，拿到 taskId 前禁用，点击调用真实 `AstroControl.pause()`，按时序呈现 `PAUSE_REQUESTED → PAUSED`，消费 `task.pause_requested / step.paused / task.paused` 事件，run 以暂停收尾时不作为失败。

**浏览器 E2E（`tools/v2-pause-browser-test.js`，真实 headless Chrome + 本地 HTTP + CDP，零新增 npm 依赖）**：

| 验证点 | 结果 |
|---|---|
| 页面启动、暂停桥可用、注入可中止门控慢工具 | PASS |
| 运行中 UI 出现可用「暂停」按钮（拿到真实 taskId 后可点） | PASS |
| 门控工具确已进入执行（真实在飞步骤） | PASS |
| 真点击「暂停」按钮 | PASS |
| 点击后呈现 `PAUSE_REQUESTED` 语义（不提前谎称已暂停） | PASS |
| 在飞工具确实收到 abort 并释放 | PASS |
| 持久化任务 `pausedAt` 存在、`pauseRequestedAt` 已清空 | PASS |
| 事件链含 `task.pause_requested / step.paused / task.paused` | PASS |
| 在飞步骤 `abortCode=PAUSE_REQUESTED`（pause 语义由编排层恢复） | PASS |
| 刷新后卡片标注「已暂停」并提供继续入口 | PASS |
| 真点击「继续任务」→ `pausedAt` 清除、`task.recovered` 入链、`recoveries=1` | PASS |

合计：**15/15 PASS**。典型实测证据：`abortCodes:["PAUSE_REQUESTED",null,null,null]`；刷新后卡片文案 `1/4 步 · EXECUTE · 已暂停 · 保存于2026-11-24 09:20`；恢复后 `pausedAt:false, pauseRequestedAt:false, recoveries:1`，事件尾 `task.recovered`。

core 回归（本次实跑）：`control-test` **86/86**、`v2-task-pause-resume-test` **21/21**、`v2-recovery-confirmation-test` **17/17**、`v2-localstorage-cas-test` **11/11**、`v2-abortable-tools-test` **13/13**，全部 PASS，工作树无测试污染。i18n 检查（英文模式）：界面残留维持 **27 条**（与改动前基线一致），新增暂停文案均有 `i18n.en-extra.js` 词条，扫描结果中无暂停相关中文残留。

结论：阶段 B 的暂停流程已完成真实浏览器端到端点击验收，`PAUSE_REQUESTED → PAUSED` 的 UI 呈现来自真实状态与真实事件，不伪造 PASS。门控慢工具是确定性验收夹具，真实工具可中断边界仍见 R-01/R-02。

## 十二、R-08 ~ R-12 修复后的追加验证（2026-11-24）

修复内容概述：
- **R-08**：`core/control.js` 引入 `BroadcastChannel('astrum.control.pause')` 跨标签页暂停广播（仅浏览器窗口存在时创建）、`persist()` 对 `STALE_WRITE` 做一次「取最新 revision 并吸收 `pauseRequestedAt` 后重试」，`core/orchestrator.js` 在步骤标记 `running` 后回调 `onStepStarted` 落盘。
- **R-09**：固化检查点裁剪为「主事务提交后独立执行、失败吞掉」的刻意设计，并用故障注入证明其隔离性。
- **R-10**：`getHealth()` 暴露 `deprecatedUpdatedAtFallback / updatedAtFallbackUsed / lastUpdatedAtFallbackAt`，对无 `expectedRevision` 的旧调用方记账弃用。
- **R-11**：不改状态机，补测试证明恢复确认与普通审批严格区分。
- **R-12**：`validateFidelity` 增加显式 64-hex 判定，统一注释与错误码语义。

| 测试 | 结果 | 关键覆盖 |
|---|---|---|
| `tools/v2-cross-tab-pause-test.js` | **14/14 PASS** | 双标签页沙箱：B 页 pause 广播 → A 页在飞中止、PAUSED 收尾、`pausedAt` 落盘、事件链完整；无 BroadcastChannel 时退化轮询且不建通道 |
| `tools/v2-checkpoint-prune-test.js` | **17/17 PASS** | 裁剪事务 delete 故障注入下保存仍成功且 revision 递增、无部分删除、最新检查点可读；正常路径裁剪回落到 20；内存态检查点维持 20 |
| `tools/v2-multi-tab-concurrency-test.js` | **20/20 PASS** | 原 17 项 + R-10 弃用标记、兜底计数、显式 revision 不计入 |
| `tools/v2-recovery-confirmation-test.js` | **24/24 PASS** | 原 17 项 + R-11 skill/claim 审批不被恢复确认处理、保持原状、无错误码/非等待态被拒、UI 只筛选恢复确认步骤 |
| `tools/v2-recovery-idempotency-test.js` | **13/13 PASS** | 原 10 项 + R-12 短哈希=unverified、64-hex 不符=hash_mismatch、大写 64-hex 一致可复用 |
| `tools/v2-idempotency-recovery-test.js` | **16/16 PASS** | 回归：哈希不符进入人工确认且不覆盖原结果 |

结论：R-08~R-12 均以真实测试证据通过，不伪造 PASS；R-09/R-10/R-11 为「固化既有刻意设计 + 增强可观测/区分测试」，R-12 为「收紧校验语义」，均未引入破坏性迁移。
