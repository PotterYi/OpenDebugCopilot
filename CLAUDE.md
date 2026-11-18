# DebugCopilot — 协作与开发规则

以下规则对每次会话、每项任务都生效，不得绕过。

## 一、临时文件规则

1. **位置**：无论用于验证还是功能需要，创建的所有临时文件必须放在项目根目录的 `.tmp/` 下，不得散落在仓库其他位置。
2. **分组**：同一批临时文件放在同一个子文件夹里，文件夹名要能简要说明这批文件的用途（示例：`.tmp/log-date-parse-check/`、`.tmp/rule-match-bench/`）。
3. **隔离**：正式项目代码（`src/` 等）严禁引用 `.tmp/` 中的任何代码、配置或数据。
4. **路径计算**：测试与脚本的临时目录必须通过统一 helper（`verify/unit/tmp.mjs`）计算，确保落在项目 `.tmp/` 下，禁止写到父目录；运行期配置（`configs/`）属于正式项目文件，**永远不得写入 `.tmp/`**。
5. **清理**：任务结束后判断临时文件是否还有用；无用则删除。需要留档的内容，写成正式文档存入 `docs/` 并在索引登记，不保留临时文件本体。

## 二、文档规则

5. **长度**：单个文档不超过 500 行，接近 450 行就要规划拆分。
6. **拆分**：超长文档按序号拆分（如 `01-xxx.md`、`02-yyy.md`），并用索引文档（`docs/README.md`）说明大纲和文档地图。
7. **入口**：所有文档必须在 `docs/README.md` 登记（编号、标题、内容、行数）。
8. **同步**：设计变更时增量更新对应文档，并在索引的变更记录中留痕；未定结论用【待确认 Qn】/【待补充 Tn】标记，汇总在 `06-里程碑与待确认.md`。

## 三、开发流程规则

9. **先确认后开发**：动手开发前，必须先向需求方说明本次开发方案（目标、改哪些文件、技术方案、验证方式、风险），得到明确确认后才能开始写代码。
12. **测试要执行代码**：断言必须真正执行目标代码路径；禁止用源码文本匹配/字符串存在性代替运行验证（字符串在文件里，不等于运行时能走到）。

11. **stdout 纪律**：stdout 只输出主结果（JSON、人类可读结论、启动 URL、冒烟结果）；日志、诊断、警告一律走 stderr（可另写文件），禁止任何日志污染 stdout。

10. **方案变更同样确认**：开发过程中如发现需要偏离已确认方案（换技术路线、扩大改动范围），先停下来说明原因并重新确认。

## 四、文档地图

| 文档 | 内容 |
| --- | --- |
| `docs/README.md` | 文档索引、变更记录、文档规范 |
| `docs/01-概述与使用场景.md` | 产品定位、场景、使用流程 |
| `docs/02-功能需求.md` | 功能需求与优先级 |
| `docs/03-总体架构.md` | 架构、数据流、规则引擎、日志、诊断编排 |
| `docs/04-数据模型与接口.md` | 数据模型、IPC 接口 |
| `docs/05-技术选型与安全.md` | 技术选型、安全、非功能指标 |
| `docs/06-里程碑与待确认.md` | 里程碑、待确认/待补充清单 |
| `docs/07-术语与同步约定.md` | 术语表、同步约定 |
| `docs/08-DEMO实现现状.md` | DEMO 已验证实现与差异对照 |
| `docs/09-M1开发方案.md` | M1（CLI 闭环）方案与实施步骤 |
| `docs/10-M1验证记录.md` | M1 真实验证结果与问题修复 |
| `docs/11-M2开发方案.md` | M2（桌面版 + WebUI）方案与实施步骤 |
| `docs/12-M2验收清单.md` | M2 自动化/手工验收清单与已知限制 |
| `docs/13-M2打包评估.md` | M2 打包结论与 M3 打包方案 |
| `docs/14-RuoYi靶场部署.md` | 本地 RuoYi 测试靶场部署与验证 |

## 五、前端约定

11. 零框架 UI 中凡使用 `hidden` 属性控制显隐，全局样式必须保留 `[hidden] { display: none !important; }`；
    组件里的 `display` 规则不得压过它（作者样式会覆盖 UA 的 `[hidden]`，导致 `el.hidden = true` 静默失败）。

## 六、当前状态

- 主开发仓库：`G:\develop\project\OpenDebugCopilot`（公开仓库 `PotterYi/OpenDebugCopilot`）；旧 `G:\develop\project\DebugCopilot` 仅保留历史参考，不再作为主开发目录。
- M0（DEMO 验证）已完成：内嵌浏览器 + 请求捕获 + 对话式定位；**DEMO 代码未留档**。
- M1（CLI 闭环）已完成并通过真实模型验证，代码已推送 GitHub。
- 当前阶段：M3 发布阻塞项已清（2026-11-04）。M1/M2 已完成，tag `v0.2.0`；M3 已完成前端堆栈映射、T22 本机预检兜底、T24 `--dir`/NSIS/portable 打包、单实例与 UI 端口占用回退。file:line 跳转与完整符号索引仍是后续体验项。运行日志：全局日志（轮转） + 每次诊断 `runs/<runId>/run.log`，UI 可打开日志。UI 诊断入口：请求 + 页面错误各一个；Mock 仅 CLI/测试。前端配置已简化：`frontendProjectRoot` 为主字段，`frontendSourceRoot` 与 `frontendStartCommand` 均为可选（源码根留空默认项目根，堆栈映射支持 src 前缀多级兜底）。工具退出时会等待并停止由本工具启动的前端 dev server，并同步兜底杀进程树。已实现前端 dev server 一键启动/停止/重启。2a/2b/2c 已完成：Agent 输出结构化 search/replace；应用侧做路径/唯一匹配校验与 diff 预览；用户确认后主进程原子写入，备份原文件并支持撤销；可运行验证命令并在成功后重启前端，模型始终无写权限。工作区支持多配置管理：`configs/profiles.json` 保存 workspace+routing 快照，UI 顶部可切换/保存为/重命名/删除；切换配置会重载路由并停止旧前端服务。历史诊断页是手风琴 + 纯对话流：默认只显示历史清单，点击某条只保留该条并在其下展开完整对话，再次点击收起并恢复清单；仅最新一条助手消息提供应用/撤销/验证/批量操作，更早轮次只读；每条记录可删除；底部「继续诊断」会追加新的完整诊断并显示简化思考进度。诊断过程通过 `dc:diagnose:progress` 展示日志关联、源码读取、AI 分析、工具调用、修复预览、自检等阶段。高级配置支持「其他后端源码目录」，默认不扫描/不修改；诊断时勾选「同时扫描其他后端源码」才授权读取、搜索与修复。日志关联报告展示实际策略（business-id/trace-id/时间窗等），capture 不再显示未注入的 marker；time-window 明确标注兜底风险。业务 ID 提取覆盖 headers/path，支持 empNum/courseCode 等后缀并过滤通用 code/status。marker 仅保留给 CLI/scenario fire 模式。日志自动探测会丢弃未换行的采样末行；无严格候选时按最高命中率降级或 raw 兜底，并在结果中给出降级/未解析告警；诊断解析器可在高级配置手动指定。超轮次/费用上限不再丢弃证据，保留部分结论并标记未完成；模型菜单可配置模型、最大轮次（留空不限）、费用和超时；追问会重建只读日志/源码工具链，并在快照中带上上一轮 toolCalls 的按成本裁剪摘要（源码读只留 args、搜索只留 path:line、日志保留截断摘要）。capture 模式无请求重放，验证后需用户重新操作并诊断新请求；后续可做自动等待新请求/重放对比。运行侧 classpath（2026-11-14）：新增 `list_java_processes` / `runtime_classpath`，读取 `jps`/`jcmd` 可见的 `java.class.path`、`loader.path`、executable jar manifest 与 `BOOT-INF/lib` / `WEB-INF/lib`，与声明清单在工具内部求差集，仅返回 missing / versionMismatch / runtimeOnly；`declaredFile` 限源码根、run 目录或工作区，不注入 agent。运行进程识别（2026-11-14）：新增 `list_processes`（pid/ppid/name/startedAt/脱敏 command，默认当前用户/会话，支持 pid/port/name/commandContains/javaOnly/limit）；`core/redact.mjs` 新增 `redactCommand`，覆盖命令行空格分隔值与 `secretKey=`/`pass=` 等写法，先脱敏再截断；docs/05 §8 已登记该类数据会离开本机。诊断前 Triage（2026-11-14）：桌面端在请求/Console 诊断前用内联卡片、元素诊断用紧凑弹窗收集复现环境/影响范围/最近变更（默认不确定、可跳过）；答案写入 `evidence.triage` 与 `result.meta.triage`，prompt 位于症状后、证据前，报告在结论前展示「诊断前提」；Agent 不得重复询问已回答问题。CLI 支持 `--triage`/`--triage-note`/`--triage-file`。docs/05 §8 已登记 triage 出站数据。只读文件/Git（2026-11-15）：新增 `list_dir` / `stat_file`（相对路径、类型、大小、mtime，无内容；敏感路径与 `.git` 隐藏）和 `git_status` / `git_log` / `git_diff`（只读 Git，默认 stat，完整 patch 需显式单文件；固定禁用 pager/外部 diff/textconv/fsmonitor/locks）。路径统一走 `core/path-policy.mjs`；`read` 只读 evidence，`run_command` 错误提示引导到新工具；docs/05 §8 已登记文件元数据与 Git 元数据出站。工具边界可发现（2026-11-16）：`safe()` 保留 AppError details，边界错误返回 `details/hint/usage`；同一工具同类错误连续 2 次追加 `guardrail`，同一工具成功清零；agent-sandbox 的 COMMAND_DENIED 附带 reason 与实际探测命令；完整权限 Bash 拒绝同样带 usage/护栏；prompt/工具描述增加边界表，禁止用 python -V/echo/print 试探；错误分支参数统一脱敏。Maven 结果复用（2026-11-16）：run_command 对 dependency:tree/build-classpath/help:evaluate 和成功 compile 做 per-run 缓存（pom/settings fingerprint、TTL 5 分钟、写入后清空、返回 cached/cacheAgeMs）；新增 maven_dependencies 原子工具，一次全量 tree 并在内部过滤 includes/excludes/scope，可选生成 declaredFile 给 runtime_classpath；只支持 backend，仅沙箱/完全权限暴露。docs/05 §8 已登记依赖元数据出站。用量与缓存诊断（2026-11-16）：usage 保留 per-model provider/canonicalModel/costBasis/cache 明细与逐轮摘要；UI/报告展示缓存读/写、模型/供应商与成本，非 firstParty 标“估算”；DC_DEBUG_USAGE=1 时写 run.log；systemPrompt 改为静态前缀 + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + 动态后缀。已确认现有 1.93M cache read / 0 cache creation 与用户 settings 里的 DeepSeek Anthropic 兼容端点一致：缓存命中生效，但 provider 不报 cache write。自动修复重试（2026-11-17）：sandbox / in-place / full 验证失败时，编排层回灌结构化失败输出并调用 followUp(purpose=repair) 自动重试一次；默认预算 6 轮/$1/120s 且取剩余全局预算，超时/依赖/网络/权限/无关错误/recheck>1 不重试；重试后重新 extract+self-check，仍失败才落回 needsMoreInfo；usage 合并并展示 repair 状态。 症状验证与安全重放（2026-11-17）：symptomCheck 支持 pending/passed/failed/skipped，gates.level 为 verified/symptom-verified/unverified/failed；报告/UI 在结论前显示复现步骤和手动确认按钮，CLI 支持 --symptom/--symptom-note。workspace.replay 默认关闭，仅安全方法、允许 origin、无 Authorization/Cookie/token 头的捕获请求生成 fixture 并在修改后自动重放；比较 HTTP/业务 code 签名，不可重放/认证失败/不可达时回退人工确认。 非代码修复动作（2026-11-17）：fixes 只承载代码 search/replace；配置、构建刷新、补打包依赖、重启/换实例、数据/部署修复写入平级 actions，含 requires/steps/commands/verification/risk/reversible。P0 仅报告/UI/CLI 展示和复制命令，不自动执行；gates.remediation 记录数量，fixes 为空 + actions 非空时明确“不需要修改代码”。 长列表分页（2026-11-17）：列表工具截断时先全量 redacted 溢写到 evidence，返回 total/offset/limit/nextOffset/file/fields；query_result 支持 field/offset/limit/filter 二次查询；runtime_classpath 全量 diff 并支持 mode/offset/limit；maven_dependencies 全量溢写并支持 offset/limit；spill 支持 force。 构建模型探针（2026-11-18）：新增 buildProbeRoot（留空默认源码根父目录）与 inspect_build_model，只读解析 Maven POM modules/parent、IntelliJ modules.xml/iml、时间戳与 staleHints；探针根只服务该工具，拒绝 workspace.xml、同级源码和敏感文件；P0 不执行 effective-pom。 参数化运行时事实（2026-11-18）：新增 runtime_facts（system_properties/classloader/flags/command_line），按 selectors 读取；comparePid/declaredFile 只返回差异；敏感值永久脱敏、通配只返回键名、无 selector 只给摘要；结果分页/溢写/query_result。classloader 不含 jar URL，env/open files 留 P1。 源码/配置检索扩展（2026-11-18）：search_source 默认纳入 POM/YAML/properties/JSON 等配置并可 includeConfig=false；支持 caseSensitive、安全正则（worker + 5s 超时，拒绝反向引用/后顾/嵌套量词）、offset/limit/nextOffset/hasMore 稳定分页与 query_result field=matches 续页；排除 lock/压缩产物/source map 与敏感文件；read_source 支持配置路径并经 resolveWithinRoot 做越界/敏感校验，未知类型返回 SOURCE_FILE_TYPE_UNSUPPORTED。 可证伪结论（2026-11-18）：结果新增必填 rejectedHypotheses（hypothesis/refutedBy/reason，最多 5 条），空数组必须给 noRejectedHypothesesReason；新增 core/evidence-refs.mjs 从证据包构建真实路径索引，evidence-refs 与 hypothesis-disclosure gate 校验引用存在性、结构和理由；报告/UI/CLI 在结论前展示「排除的假设」；recheck 增加 rejected-hypotheses 相似度；quote 原文校验留 P1。
- 采用**方案 B**：依据 `docs/08-DEMO实现现状.md` 从零重建；未覆盖的细节按 `docs/06` 的 T 项继续向需求方确认。
- 新功能开发前必须先确认方案（目录结构、模块接口、验证方式）。
