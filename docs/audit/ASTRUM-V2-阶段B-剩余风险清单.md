# ASTRUM V2 阶段 B 剩余风险清单

本清单保留所有未彻底解决的问题，不因验收而删除。

## R-01 不接收 AbortSignal 的工具仍可能在超时后继续执行

- 状态：**网络检索/合成链路已修复（2026-11-23 补充）**；本地同步计算仍为固有边界。
- 已修复：`Sources.searchMany → callEndpoint → withRetry → fetchJSON → fetch` 已全链路贯穿外部 `signal`；`fetchJSON` 用 `withTimeout(ms, externalSignal)` 组合外部取消与端点超时；重试等待期响应 abort，取消后不再发起下一次请求。
- 已修复：`evidence.search`、`paper.search`、`llm.compose` 由 `abortable:false` 改为 `abortable:true`；`llm.compose` 在入口与合作点检查 signal，取消后不产出被废弃答案。
- 已修复：取消/暂停错误不再累计端点熔断失败，避免被误判为可重试网络错误。
- 残留：`kepler.*`、`kb.lookup`、`fits.parse`、`compare.curate`、`compose.*` 仍是本地同步计算，无法逐指令中断；其耗时为毫秒级并受 `timeoutMs` 约束，超时仍记录 `ABORT_UNSUPPORTED`、`abortConfirmed=false`。
- 责任边界：同步计算的中断能力受 JS 执行模型限制，不是编排层可伪造解决的问题。

## R-02 暂停不可中断工具可能长时间等待

- 状态：**网络工具已修复（2026-11-23 补充）**；本地同步计算仍为固有边界。
- 已修复：检索类工具现在真正接收 signal，暂停会中止底层 fetch 并把在飞步骤回队，无需等待请求自然结束。
- 已验证：暂停时 `evidence.search` 返回 `pendingAbort=true / pause=true / abortCode=PAUSE_REQUESTED`；预取消不发起任何网络请求；在飞取消后底层 fetch 的 signal 处于 `aborted` 且不再重试。
- 残留：本地同步计算工具（`kepler.*`、`kb.lookup`、`fits.parse`、`compare.curate`、`compose.*`）在暂停时仍需等待其同步执行结束（通常为毫秒级，且阻塞事件循环期间暂停请求本身也无法被处理）；若出现异常长计算，只能等 `timeoutMs` 硬超时。
- 已做：UI 仍返回“将在安全边界后暂停”，不提前写 `pausedAt`，不伪造 PAUSED。

## R-03 恢复人工确认只有状态，没有完整审批动作

- 状态：**已修复（2026-11-24 补充）**。
- 已修复：`AstroControl.confirmRecovery(taskId, stepId, decision)` 提供 `rerun / reuse / abandon` 三个显式动作，经 `task.resume` 能力授权、CAS 事务落盘并追加 `task.recovery_confirmed` 事件。
- 已修复：`AstroRecovery.decide()` 以 `provenance.recoveryConfirmation` 短路自动推导：人工确认复用不会被重复恢复翻回确认；`rerun` 标记带 `forAttempt`，超过该 attempt 后自动失效。
- 已修复：`reuse` 把步骤从 `waiting_approval` 恢复为 `ok` 并清错误；`rerun` 走 `resetForRerun` 重置为 pending；`abandon` 置为 `blocked` 且错误改为 `operator_abandoned`，任务不静默完成。
- 已修复：`AstroControlBridge.confirmRecovery()` 透传动作；UI 待审批卡片对 `recovery_confirmation_required` 步骤显示「授权重跑 / 确认复用 / 放弃该步」入口，只针对恢复确认，不与 skill/claim 审批混淆。
- 已验证：`tools/v2-recovery-confirmation-test.js` 17/17；权限拒绝、CAS 冲突、非法决策、非确认态、重复恢复均覆盖。
- 残留：确认动作是「用户判断已核验」的人工出口，系统不独立核验远端真实状态（见 R-06b）；确认入口目前只在恢复卡片，步骤详情面板未单独提供。

## R-04 localStorage/memory 回退不具备跨标签页原子 CAS

- 状态：**已修复（2026-11-24 补充）**。
- 已修复：`core/task-store.js` 的 localStorage 后端把整段 read→compare→write 包进浏览器原生 **Web Locks**（`AstroTaskStore` 实例命名空间锁名），跨标签页互斥，杜绝两标签读到同 revision 后都写入造成的丢更新，包括整张 map 的并发读改写（不同任务互不抹除）。
- 已修复：Web Locks 不可用时退化为原单上下文同步段，`getHealth()` 明确标记 `crossTabAtomic=false / lockMode='same-context-only'`，不伪造跨标签保证；锁回调异常统一转成 rejection，避免某些实现（如 Node 内置 locks）异常时不释放锁导致后续写入挂起。
- 已验证：`tools/v2-localstorage-cas-test.js` 11/11（并发 CAS 恰一成功一 STALE_WRITE、不同任务互不抹除、无锁降级标记、owner 命名空间隔离、锁异常释放）。
- 残留边界：memory 后端为每个 `create()` 实例独有，不跨上下文共享，本就不是跨标签页存储方案；`getHealth().crossTabAtomic=false` 明确标记。跨浏览器/跨设备的真正 CAS 仍需 IDB 或服务端，不在本范围。

## R-05 非幂等/外部副作用的判定仍依赖工具声明

- 事实：`sideEffect` 由注册表声明；未声明按“有副作用风险”保守处理。
- 影响：若新工具错误声明 `sideEffect:false`，恢复时会被允许重跑；运行时无法自动推断第三方写操作是否真正幂等。
- 已做：未声明默认进入人工确认；只读现有工具显式声明 false；外部调用新增 `executionId / idempotencyKey / receipt / externalState` 追踪（`v2-external-call-recovery-test` 12/12）。
- 剩余：声明正确性仍由工具作者负责，需要后续注册表评审/契约测试。

## R-06 远端 exactly-once 仍无法保证

- 事实：当前仓库没有 HTTP POST/外部写工具；`idempotencyKey` 是传递契约，第三方服务不一定识别。
- 影响：未来接入外部写工具时，最多只能声明 at-least-once 或 at-most-once；远端没有回执时只能进入人工确认。
- 已做：本地已建立稳定幂等键、唯一执行 ID、回执/远端状态持久化；非幂等外部调用在远端确认成功时复用、明确失败时重跑、未知时确认。
- 剩余：未与具体第三方 API 协商幂等键语义，也没有远端查询/对账接口。

## R-06b 外部回执是工具自报，缺少独立核验

- 事实：`receipt / externalState` 由工具结果写入 `provenance`，恢复层无法独立访问第三方系统。
- 影响：工具若错误上报 `succeeded`，恢复会复用；若错误上报 `failed`，恢复会重跑。
- 已做：回执与结果一并持久化，校验位于 `decide()`，直接调用无法绕过。
- 剩余：后续需要为具体外部系统增加独立的状态查询/签名回执校验。

## R-07 阶段 B 暂停流程未做浏览器端到端点击验收

- 状态：**已修复（2026-11-24 补充）**。
- 已修复：`AstroControlBridge.pause(taskId, opts)` 暴露真实 `AstroControl.pause()`，携带 principal 与 store，含 profile 归属校验；`AstroControl.run()` 新增 `onTask(id, state)` 观察者，让运行中 UI 在 `onEvent` 发出之前就拿到真实 taskId（观察者异常不阻断任务）。
- 已修复：`controlAnswer()` 在「取消」旁新增「暂停」按钮：拿到 taskId 前禁用，点击后呈现 `PAUSE_REQUESTED` 语义（「暂停请求已发出」/「等待暂停生效」），不提前谎称已暂停；在 `onEvent` 消费 `task.pause_requested / step.paused / task.paused` 更新真实状态；run 以 `paused/pauseRequested` 收尾时不作为失败，刷新后由恢复卡片提供继续入口。
- 已验证：`tools/v2-pause-browser-test.js` **15/15 PASS**（真实 headless Chrome + 本地 HTTP + CDP，注入可中止门控慢工具；真点击「暂停」→ 在飞工具收到 abort → 持久化 `pausedAt`、`task.pause_requested`/`task.paused`、`step.abort.code=PAUSE_REQUESTED`；刷新后卡片标注「已暂停」并真点击「继续任务」→ `pausedAt` 清除、`task.recovered` 入链）。
- 已验证：core 回归 `control-test` 86/86、`v2-task-pause-resume-test` 21/21、`v2-recovery-confirmation-test` 17/17、`v2-localstorage-cas-test` 11/11、`v2-abortable-tools-test` 13/13 全绿。
- 残留边界：门控慢工具是为确定性验收注入的测试夹具，真实工具的可中断性边界仍见 R-01/R-02；跨标签页暂停收尾仍由 R-08 记录。E2E 使用零依赖 headless Chrome，不新增 npm 依赖。

## R-08 跨标签页暂停请求的收尾依赖运行页

- 事实：其他标签页运行中时，`pause()` 只持久化 `pauseRequestedAt`，由持有活跃运行的标签页在批次边界确认 `pausedAt`。
- 影响：若运行页在确认前崩溃/关闭，任务会停留在 `pauseRequestedAt` 状态；`resume` 会清除该请求并继续。
- 已做：请求态与完成态可区分；恢复不会重复执行已完成步骤。
- 未做：没有 BroadcastChannel 级联唤醒/超时收尾机制。

## R-09 检查点裁剪在事务提交后执行

- 事实：任务/事件/检查点同事务写入，`pruneCheckpoints` 在提交后单独执行。
- 影响：裁剪前崩溃会留下多余检查点，不影响权威任务记录与恢复正确性。
- 已做：歧义只存在于派生数据数量，不影响一致性。

## R-10 旧调用方仍可使用 updatedAt 兜底

- 事实：未传 `expectedRevision` 的旧调用方保留 `updatedAt` 字符串比较。
- 影响：时钟回拨或同毫秒写入仍可能漏检；新链路（Control/run/resume）全部使用 `expectedRevision`。
- 已做：旧接口兼容，P4S-10 保留；P4S-09 验证 revision 主路径。
- 未做：强制所有外部调用方升级会破坏兼容性。

## R-11 恢复确认状态使用既有 `waiting_approval`

- 事实：没有新增步骤状态，复用既有审批状态并增加 `error.kind` 区分。
- 影响：既有审批 UI 可能把恢复确认当作普通审批展示；语义靠 `error.kind` 区分。
- 已做：错误码稳定，任务不会被误判完成。
- 未做：新增独立状态需要迁移分析与 UI 改造，本阶段未做。

## R-12 历史任务的无哈希/短哈希结果不会复用

- 事实：UNKNOWN 步骤必须复算 SHA-256；旧记录若没有完整哈希会进入人工确认。
- 影响：旧任务恢复时可能需要人工确认，而不是静默复用；这是安全性收紧。
- 已做：明确错误原因 `unknown_idempotency_*`。
- 未做：不做“猜测式”迁移哈希，避免把不可信结果标记为已验证。
