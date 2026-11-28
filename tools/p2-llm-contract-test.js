'use strict';
/* V2 阶段 D · 模型表述契约（静态守卫 + 文案词表）
 * 说明：本测试检查 app.js 中不可退化的分支与字段，避免出现
 * 「证据为空却静默跳过」「空文本被当成功」「无统一快照」的回归。 */

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var app = fs.readFileSync(path.join(ROOT, 'core', 'app.js'), 'utf8');
var i18n = fs.readFileSync(path.join(ROOT, 'core', 'i18n.js'), 'utf8');

var passed = 0, failed = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

ok('严格文献任务无证据时明确拒绝', /evidence_required/.test(app) && /requestStatus: 'skipped'/.test(app));
ok('无证据的普通问题允许通用解释', /allowExplain/.test(app) || /noEvidence \? 'C'/.test(app));
ok('无证据解释带强制标注', /不作为研究结论/.test(app));
ok('统一 llmExecution 快照', /meta\.llmExecution\s*=\s*\{/.test(app));
ok('快照含 schemaVersion', /schemaVersion: 1, provider: src\.id/.test(app));
ok('空返回单独标记 empty', /responseStatus: resp/.test(app) && /code === 'empty' \? 'empty'/.test(app));
ok('空文本不写入正文', /if \(body\) \{/.test(app));
ok('异常路径也写快照', /responseStatus: 'exception'/.test(app));
ok('空返回不显示为未知失败', /模型返回空内容/.test(app));

ok('新增文案进入 i18n 词表（拒绝）', /无法给出带文献依据的结论/.test(i18n));
ok('新增文案进入 i18n 词表（通用解释）', /不作为研究结论/.test(i18n));
ok('新增文案进入 i18n 词表（空返回）', /模型返回空内容/.test(i18n));
ok('旧记录标注进入 i18n 词表', /未包含执行记录/.test(i18n));

/* 阶段 E：统一执行快照 */
ok('执行快照 schemaVersion=2', /schemaVersion: 2/.test(app));
ok('快照含 executionId', /executionId:/.test(app));
ok('快照含 routing', /routing: \{/.test(app) && /reason: info && info\.route/.test(app));
ok('快照含 planner', /planner: ctrlPlan \?/.test(app));
ok('快照含 overallStatus', /overallStatus: overall/.test(app));
ok('legacy 回答也写快照', /overallStatus: 'no_execution'/.test(app) && /verdict: 'LEGACY'/.test(app));
ok('旧消息标注记录缺失', /记录缺失/.test(app));

/* 阶段 F：Runtime 开关持久化与优先级 */
ok('URL 支持 0/1 覆盖', /agentRuntime=\(0\|1\)/.test(app));
ok('URL 优先于设置', /function agentRuntimeOn\(\)[\s\S]{0,160}urlRuntimeOverride\(\)/.test(app));
ok('默认关闭', /agentRuntime: false/.test(app));
ok('开关变更立即生效', /applyRuntime\(\);/.test(app) && /persist\(\);/.test(app));
ok('自检显示生效来源', /ASTRUM_AGENT_RUNTIME_SOURCE/.test(app));

/* 阶段 G：可观测性与诊断导出 */
ok('执行快照详情面板', /function execSnapshotPanel\(/.test(app) && /execSnapshotPanel\(execSnap\)/.test(app));
ok('空答案按执行状态分支', /function emptyAnswerText\(/.test(app) && /emptyAnswerText\(ans\)/.test(app));
ok('诊断导出入口', /function exportDiagnostics\(/.test(app) && /导出诊断信息/.test(app));
ok('诊断导出密钥白名单', /\(key\|apiKey\|api_key\|token\|authorization\|secret\|password\)/.test(app));
ok('诊断不导出对话正文', /lastExecution:/.test(app) && /function exportDiagnostics[\s\S]{0,1200}?lastExecution/.test(app));

/* 阶段 H：失败状态归一 */
var ex = fs.readFileSync(path.join(ROOT, 'core', 'agent-executor.js'), 'utf8');
var orch = fs.readFileSync(path.join(ROOT, 'core', 'orchestrator.js'), 'utf8');
ok('模型超时归为 timeout', /failCode === 'TIMEOUT'\) status = 'timeout'/.test(ex));
ok('限流归为 blocked', /failCode === 'RATE_LIMITED'\) status = 'blocked'/.test(ex));
ok('取消归为 cancelled', /failCode === 'CANCELLED'\) status = 'cancelled'/.test(ex));
ok('Agent 异常构造失败成果', /AR\.create\(\{[\s\S]{0,500}status: 'failed'/.test(orch));

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) { console.log('失败项：' + failures.join('、')); process.exit(1); }
