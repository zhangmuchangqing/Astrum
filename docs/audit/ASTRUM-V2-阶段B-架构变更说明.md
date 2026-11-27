# ASTRUM V2 阶段 B 架构变更说明

## 一、AbortSignal 传递链

真实链路（以当前源码为准）：

```
AstroControl.run / resume
  → makeRunController(taskId, externalSignal, state)   // 任务级控制器
  → AstroOrchestrator.runPlan(plan, state, { signal })
    → executeOne(planStep, state, opts)
      → withTimeout(fn, spec.timeoutMs, taskSignal, { abortable })
        → 步骤级 AbortController
        → rt.signal = 步骤控制器 signal
      → AstroRegistry.get(tool).run(args, ctx, spec, cfg, deps, rt)
        → AstroToolGateway.run(...)                      // 授权与参数校验不绕过
          → 实际工具
            → Simbad.lookup(... signal) / Sources / fetch
```

关键点：

- **任务级信号**由 `AstroControl` 持有，`pause()` / 外部 `AbortController` 都作用于它。
- **步骤级控制器**由 `withTimeout` 创建，超时只中止当前步骤；步骤完成会清理定时器与任务级监听器。
- **不合并成一个不可追溯的 AbortSignal**：取消来源通过 `signal.reason` 与结果中的 `abortCode` 保留。
- **不伪造取消**：工具不支持信号时记录 `abortSupported=false`，超时标记 `ABORT_UNSUPPORTED`；暂停/用户取消时等待其自然到达安全边界。
- **网络链路真实贯穿（R-01/R-02 修复）**：`rt.signal` 现在到达 `Sources.searchMany(queries, { signal }) → callEndpoint(ep, q, signal) → withRetry(fn, 2, [q, signal], signal) → fetchJSON(url, ms, signal) → fetch({ signal })`；`fetchJSON` 用 `withTimeout(ms, externalSignal)` 把端点超时与外部取消组合进同一个 fetch 信号。取消后不再发起新请求，重试等待期也会响应 abort，且取消不计入端点熔断失败。

取消来源与稳定码：

| 场景 | `abortCode` | 既有 `errorName` |
|---|---|---|
| 步骤超时 | `TIMEOUT` | `TimeoutError` |
| 步骤超时且工具不可中断 | `ABORT_UNSUPPORTED` | `TimeoutError` |
| 用户取消 | `USER_CANCELLED` | `UserCancelled` |
| 暂停请求 | `PAUSE_REQUESTED` | `PauseRequested` |
| 上游取消 | `UPSTREAM_ABORTED` | `AbortError` |
| 工具确认中止 | `TOOL_ABORTED` | `AbortError` |

工具声明（`core/registry.js`）：

| 工具 | abortable | sideEffect | 说明 |
|---|---|---|---|
| `kepler.ephemeris` | false | false | 本地同步计算 |
| `kepler.visibility` | false | false | 本地同步计算 |
| `kb.lookup` | false | false | 本地知识/星表 |
| `evidence.search` | true | false | signal 已贯穿 `Sources.searchMany` → `fetch`；取消后不再发起请求 |
| `simbad.tap` | true | false | `Simbad.lookup` 显式接收 signal |
| `paper.search` | true | false | 检索与全文子步骤均接收 signal |
| `llm.compose` | true | false | 入口与合作点检查 signal；本地同步合成无外部写 |
| `fits.parse` | false | false | 本地解析 |
| `compare.curate` | false | false | 本地整理 |
| `compose.target/domain/simple` | false | false | 本地组装 |

`abortable` 未声明的测试/第三方工具按“可协作”处理；`sideEffect` 未声明按“有副作用风险”保守处理。

## 二、Task 状态机

未新增 Task phase。暂停采用任务内两阶段标记：

```
EXECUTE
  └─ pauseRequestedAt != null        # PAUSE_REQUESTED
       ├─ 活动步骤 running → pending / 等待不可中断步骤完成
       └─ 持久化成功后 pausedAt != null  # PAUSED
              └─ resume: 清除 pausedAt / pauseRequestedAt，继续 EXECUTE
```

取消：

```
EXECUTE → (signal user) → ABORTED
```

- `ABORTED` 不满足 `isResumable`，普通恢复入口拒绝。
- `pausedAt` 与 `pauseRequestedAt` 互斥存在于“已确认暂停”状态；请求阶段只写 `pauseRequestedAt`。
- 合法迁移表未改；`waiting_approval` 沿用既有审批语义，用于恢复人工确认。
- R-11：恢复确认与普通审批共用 `waiting_approval`，但严格以 `error.kind='recovery_confirmation_required'` 区分；`confirmRecovery` 仅在 `status==='waiting_approval'` 且该 kind 匹配时动作，skill/claim 等普通审批不会被恢复确认动作处理，UI 确认入口使用同一条判定。此复用为刻意设计，本阶段不新增独立状态。

事件：

- `task.pause_requested`：暂停请求已接受。
- `task.paused`：暂停已确认且持久化成功。
- `task.persist_failed`：暂停请求/暂停确认/取消落盘失败，保留错误上下文。
- `task.cancelled` / `step.paused` / `step.cancelled` 保持原语义。

步骤状态：

- 在飞步骤收到 `pause` 后回到 `pending`，`step.abort.code='PAUSE_REQUESTED'`。
- 超时/取消步骤进入 `failed` / `aborted`，`step.abort` 记录 requested/supported/confirmed。
- 成功步骤不写 `step.abort`。

## 三、恢复决策机制

`AstroRecovery.decide(state, step, registry, now, opts)`：

```
ok
 ├─ 输入参数变化 → rerun
 ├─ 明确幂等
 │    ├─ 上下文全一致 → reuse
 │    ├─ 授权撤销 / 未持久化 → confirm
 │    └─ 其他变化 → rerun
 ├─ 明确非幂等
 │    ├─ sideEffect=false → rerun
 │    └─ sideEffect=true/未声明 → confirm
 └─ UNKNOWN
      ├─ validate_then_reuse 成功 → reuse
      └─ 失败 → confirm
failed → 可重试且未超上限 rerun，否则 block
running/pending/paused/waiting_approval
 ├─ provenance.recoveryConfirmation 人工决策 → reuse/rerun（一次性，forAttempt 匹配）
 ├─ 已有 recovery_confirmation_required → confirm（保持）
 ├─ 可能副作用且 attempt>0 → confirm(side_effect_state_unknown)
 └─ 其他 → rerun
```

R-03 显式确认动作：`AstroControl.confirmRecovery(taskId, stepId, decision)` 提供 `rerun / reuse / abandon`；经 `task.resume` 能力授权与 CAS 事务落盘，追加 `task.recovery_confirmed` 事件。`reuse` 将 `waiting_approval` 恢复为 `ok` 并清错误，`rerun` 走 `resetForRerun` 重置为 pending（授权标记带 `forAttempt`，重跑后自动失效），`abandon` 置为 `blocked` 且错误为 `operator_abandoned`。`AstroControlBridge` 透传，`app.js` 待审批卡片提供对应按钮；该确认只面向 `recovery_confirmation_required`，不与 skill/claim 审批混淆。

复用校验（`validateReuseContext`）：

1. 结果非空且 `ok !== false`；
2. 工具版本一致；
3. Skill 版本一致；
4. 执行上下文哈希一致；
5. Profile 一致；
6. Principal 重新授权通过；
7. 结果已可靠持久化。

未知幂等性额外复算结果 SHA-256（`validateFidelity`）。

`confirm` 的落地：步骤 `status='waiting_approval'`，`error.kind='recovery_confirmation_required'`，`runPlan` 返回 `waitingApproval`，任务不会被误判完成。

## 四、幂等性契约

- 工具注册字段：`idempotent: true | false | undefined`，新增 `sideEffect: boolean`。
- 未声明 `idempotent` = UNKNOWN，禁止默认复用。
- 明确幂等也不无条件复用：必须通过上述七项上下文校验。
- 非幂等且 `sideEffect !== false` 不自动重跑，进入人工确认。
- 外部操作已发生但本地未记录：`attempt > 0` 且可能有副作用 → `confirm`，不依赖本地“未完成”状态直接重跑。
- 不宣传 exactly-once。当前仓库没有远端写工具；未来接入 HTTP POST 等工具时，只能声明 at-least-once 或 at-most-once，除非目标服务自身支持幂等键。
- 执行上下文/Profile 写入步骤 `provenance`（`contextHash / profileId`），Skill 步骤额外记录 `skillId / skillVersionId / executionId`。

### 外部调用协议

```
步骤执行
  → executionId   = taskId + stepId + attempt + startedAt + key前缀    // 每次尝试唯一
  → idempotencyKey= sha256(taskId | stepId | tool | version | inputHash) // 重试/恢复稳定
  → ToolGateway runtime 透传 rt.executionId / rt.idempotencyKey
  → 工具可返回 { receipt, externalState: 'succeeded'|'failed'|... }
  → provenance.executionId / idempotencyKey / receipt / externalState 持久化
```

恢复时 `externalEvidence(step)` 读取 `provenance`（兼容 `result` 中的同名字段）：

| 工具声明 | 远端证据 | 策略 |
|---|---|---|
| 非幂等 + 有副作用 | `externalState=succeeded/confirmed` 且上下文一致 | `reuse`，不重复副作用 |
| 非幂等 + 有副作用 | `externalState=failed/cancelled/rejected` | `rerun` |
| 非幂等 + 有副作用 | 无回执/状态未知 | `confirm` |
| UNKNOWN + 有副作用 | 哈希有效且有回执/确认状态 | `reuse` |
| UNKNOWN + 有副作用 | 哈希有效但无回执 | `confirm(external_receipt_unverified)` |
| 明确幂等 + 有副作用 | 本地成功但远端状态 failed | `confirm(external_failed_unverified)` |
| 无副作用 | — | 维持原有幂等/TTL/凭证策略 |

该判断位于 `decide()`，因此 `AstroRecovery.plan/apply/decide` 的任何外部直接调用都走同一规则。`idempotencyKey` 是传递契约，不宣称第三方服务一定识别；远端真正支持幂等键时，重试可安全复用同一 key。

### 结果完整性校验（R-12）

`validateFidelity(step, spec, opts)` 对 UNKNOWN 步骤复核结果凭证：

```
无 outputHash / 非字符串           → unknown_idempotency_unverified   （不可核验）
非 64 位十六进制（短哈希/非法）     → unknown_idempotency_unverified   （不可核验）
完整 64-hex 且复算一致（大小写不敏感）→ ok（可复用）
完整 64-hex 但复算不等              → unknown_idempotency_hash_mismatch（哈希不符）
```

- 「不可核验」与「哈希不符」都进入人工确认，不静默复用。
- 严禁按当前结果反推或回填历史哈希：历史结果不可信，不能因此标记为“已验证”。
- 注释、错误码与实现保持一致，避免把短哈希误判为“被篡改”。

## 五、IndexedDB 并发控制

`AstroTaskStore.save(state, { expectedRevision })`：

```
db.transaction([tasks, events, checkpoints, meta], 'readwrite')
  → tasks.get(id)
  → prepareRecord：owner/project/revision/事件 seq 指纹校验
  → 冲突：tx.abort() → STALE_WRITE
  → 一致：tasks.put + 新事件 + 检查点 + meta.put
  → tx.oncomplete → 成功
```

- 比较与写入处于同一事务；不再“事务外 get、事务内 put”。
- 事件与检查点与任务记录同事务写入，避免任务成功而派生记录缺失。
- 检查点裁剪在提交后执行，失败不影响主记录一致性（最多留下多余检查点）。这是刻意设计（R-09）：裁剪/事件都是权威 `TaskState` 的派生索引，规模受 `CP_KEEP=20` 约束；放进主事务会让派生清理的偶发失败升级为权威保存失败，收益极小、风险更大。`tools/v2-checkpoint-prune-test.js` 17/17 用独立事务故障注入证明隔离性。
- localStorage 回退：整段读-比较-写在 Web Locks（按 owner 命名空间命名的跨上下文互斥锁）内完成，具备跨标签页原子 CAS；并发保存同一任务恰一成功一 `STALE_WRITE`，整张 map 的写也不会抹掉其他标签页并发保存的任务。Web Locks 不可用时退化为单上下文同步段，`getHealth()` 明确标记 `crossTabAtomic=false / lockMode='same-context-only'`，不伪造跨标签保证；锁回调异常统一转 rejection 以保证释放。
- memory 回退：每个 `create()` 实例独有，不跨上下文共享，不属于跨标签页存储方案；`getHealth().crossTabAtomic=false` 明确标记该边界。跨浏览器/跨设备的真正 CAS 仍需 IDB 或服务端，不在本阶段范围。
- 错误契约：冲突 `STALE_WRITE`；事务中断/失败 `PERSIST_TX_FAILED`；配额 `QUOTA_EXCEEDED`；记录不存在由读取层返回 `null`，不伪造空记录。
- 历史：无 `revision` 记录按 1；旧格式状态可直接加载；未传 `expectedRevision` 的旧调用方保留 `updatedAt` 兜底。`updatedAt` 兜底已标记弃用（R-10）：`getHealth()` 暴露 `deprecatedUpdatedAtFallback=true` 与 `updatedAtFallbackUsed / lastUpdatedAtFallbackAt`，无 revision 保存会计账，便于发现仍在走旧路径的调用方；新链路一律显式 revision CAS。
- BroadcastChannel 未作为依赖；所有一致性由事务保证。R-08 的跨标签暂停广播只做「加速收尾」，权威 `PAUSED` 仍由运行页在安全边界持久化确认。

## 六、事件与检查点一致性

- `task.pause_requested` 仅在暂停请求被接受时写入；`task.paused` 只在暂停确认并持久化成功后写入。
- `pausedAt` 写入与 `task.paused`、`PAUSED` 检查点在同一保存中提交；失败则回滚 `pausedAt` 并记录 `task.persist_failed`。
- 取消路径：`task.cancelled` + `ABORTED` 与最终保存绑定；保存失败返回 `persistFailed=true`，不声称已安全恢复。
- 恢复 `confirm` 不删除原结果，只改变步骤状态与错误说明，保留证据链。
- 检查点仍由 `checkpointCriticalSteps` 生成；关键步骤成功/暂停/恢复时写入，恢复用最新检查点校验。

## 七、暂停 UI 控制链（R-07）

```
controlAnswer() 运行中 UI
  ├─ onTask(id, state)                       // run() 尽早回调，拿到真实 taskId
  │    └─ 拿到 id 前「暂停」按钮 disabled
  ├─ 真点击「暂停」
  │    └─ AstroControlBridge.pause(taskId, { store })   // principal/store + profile 归属校验
  │         └─ AstroControl.pause(taskId, { store, principal })
  │              ├─ 写 pauseRequestedAt + task.pause_requested（跨标签页场景）
  │              └─ abortActive(taskId, 'pause')（同标签页在飞运行）
  ├─ onEvent 消费真实事件
  │    ├─ task.pause_requested → 「暂停请求已发出」
  │    ├─ step.paused         → 「步骤已停在安全边界」
  │    └─ task.paused         → 「已暂停」
  └─ run() 以 paused/pauseRequested 收尾（不作为失败）
       └─ 刷新后 offerResumeTask() 卡片标注「已暂停」→「继续任务」→ 恢复链路
```

- UI 不提前写状态、不伪造 `PAUSED`：`PAUSE_REQUESTED` 与 `PAUSED` 的文案分别来自 `pause()` 返回值和真实事件/持久化状态。
- taskId 由 `onTask` 观察者提供而非 `onEvent`：`onEvent` 要等批次/终态才 emit，无法让运行中的暂停按钮及时可用；观察者异常被吞掉，不影响任务执行。
- `control-bridge` 把 control 结果的 `paused/pauseRequested/verdict` 透传给 UI，且 `runWithRoute` 的 `opts.onTask` 由 bridge 转发给 `run()`。
- 端到端验收：`tools/v2-pause-browser-test.js` 用真实 headless Chrome + 本地 HTTP + CDP 真点击暂停与继续，15/15 PASS；门控慢工具是确定性夹具，真实工具可中断边界仍见第一节与 R-01/R-02。

### 跨标签页暂停广播（R-08）

```
运行页 A: run() 执行中，每步标记 running 后 onStepStarted → persist（落盘运行态）
其他页 B: pause(taskId)
  ├─ 写 pauseRequestedAt + task.pause_requested（CAS）
  ├─ BroadcastChannel('astrum.control.pause').postMessage({type:'pause-request', taskId, at})
  └─ 返回 PAUSE_REQUESTED（不谎称已暂停）

运行页 A: 接收端收到广播
  ├─ abortActive(taskId, 'pause') → 在飞步骤立即中止（加速收尾）
  └─ 批次边界持久化确认 pausedAt + step.paused + task.paused → PAUSED

无 BroadcastChannel（Node/旧浏览器）：不创建通道，退化批次边界轮询；行为等价，不伪造跨页保证。
persist 遇 STALE_WRITE：取最新 revision、吸收对端 pauseRequestedAt（若对端已收尾则吸收 pausedAt 并补记 task.paused）后重试一次，避免暂停请求被覆盖或已收尾的 PAUSED 被推翻。

运行页失联（2026-11-27 补充）：reconcilePauseRequest(taskId, {timeoutMs=30000, now})
  ├─ 前置：本页无活跃运行 && 请求超时 && 请求后无任何进展（事件/步骤时间）
  ├─ 收尾：running/paused 步骤回队 pending + abort{code:PAUSE_REQUESTED}
  │        写 pausedAt、清空 pauseRequestedAt、step.paused(stale_run)、task.paused(pause_timeout)、检查点
  ├─ CAS 落盘；STALE_WRITE → 回滚内存态并返回 contended（绝不伪造 PAUSED）
  └─ 触发入口：恢复面板打开（Bridge.reconcilePause）、再次 pause()、显式 API
```

- 广播只用于「加速收尾」，权威 `PAUSED` 始终由持有活跃运行的页面在安全边界持久化确认。
- 验证：`tools/v2-cross-tab-pause-test.js` 14/14 PASS（双页沙箱 + 互联假 BroadcastChannel + 共享 store；含无 BC 退化场景）；`tools/v2-pause-timeout-reconcile-test.js` 21/21 PASS（收尾条件、幂等、CAS 冲突回滚、存活运行页吸收 pausedAt 不被推翻）。

## 八、未改变的部分

- 所有工具仍经 `AstroToolGateway`，所有任务仍经 `AstroControl`。
- Principal、Security 授权模型、Profile 分库逻辑未改。
- Orchestrator 执行路径、Evidence/Claim/Skill 契约未改。
- 星图、银河纹理、天文计算、无关 UI 未改。
- 未新增 npm 依赖、服务端队列、后台执行系统。
