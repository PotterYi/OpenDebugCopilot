# 14 RuoYi 测试靶场部署

> 文档集索引：[README.md](./README.md) ｜ 上篇：[13-M2打包评估.md](./13-M2打包评估.md) ｜ 下篇：—
>
> 目标：在 Windows 本机部署一套真实 Spring Boot 靶场，用于验收 DebugCopilot 的路由、CORS、日志关联与源码定位。

## 14.1 选型

| 项 | 选择 | 原因 |
| --- | --- | --- |
| 后端 | RuoYi-Vue `springboot3` 分支（3.9.2 / Spring Boot 3.5.16） | 本机 JDK 17 |
| 前端 | RuoYi-Vue3（Vue 3 + Vite 6） | Node 24 兼容；Vue2 的 Vue CLI 风险高 |
| 数据库 | MySQL 8.0（Docker） | RuoYi 必需 |
| 缓存 | Redis 7（Docker） | 登录 token / 验证码 |

- 靶场目录：`G:\develop\project\test-targets\ruoyi`（**仓库外**，不污染 DebugCopilot）
- 本地后端：8080；SIT 模拟：8081（同一套 jar、同一数据库，仅端口不同）；前端：5173

## 14.2 基础设施

```bash
cd G:/develop/project/test-targets/ruoyi
docker compose up -d      # mysql:3306 / redis:6379
docker compose ps
```

- 镜像源：`docker.m.daocloud.io/library/mysql:8.0`、`redis:7`（Docker Hub 直连被阻断时使用）
- 数据库：`ry-vue`，root 密码 `ruoyi123`
- 导入（**必须指定客户端字符集**，否则中文会双重编码乱码）：

```bash
docker exec -i ruoyi-mysql mysql --default-character-set=utf8mb4 -uroot -pruoyi123 ry-vue < backend/sql/ry_20260417.sql
docker exec -i ruoyi-mysql mysql --default-character-set=utf8mb4 -uroot -pruoyi123 ry-vue < backend/sql/quartz.sql
```

- 关闭验证码：

```sql
UPDATE sys_config SET config_value='false' WHERE config_key='sys.account.captchaEnabled';
```

默认账号：`admin / admin123`

## 14.3 后端

- 数据源：`application-druid.yml` → `root / ruoyi123`
- 日志模式改为带日期（DebugCopilot 可解析）：

```xml
%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger{20} - [%method,%line] - %msg%n
```

- 外部日志配置（避免写死 `/home/ruoyi/logs`）：
  - `logback-local.xml` → `G:/develop/project/test-targets/ruoyi/logs`
  - `logback-sit.xml` → `G:/develop/project/test-targets/ruoyi/logs-sit`
- 启动：

```bash
cd backend
mvn -DskipTests clean package

# 本地
nohup java -jar ruoyi-admin/target/ruoyi-admin.jar \
  --logging.config=G:/develop/project/test-targets/ruoyi/logback-local.xml &

# SIT
nohup java -jar ruoyi-admin/target/ruoyi-admin.jar --server.port=8081 \
  --logging.config=G:/develop/project/test-targets/ruoyi/logback-sit.xml &
```

## 14.4 前端

```bash
cd frontend
npm install
npm run dev        # http://127.0.0.1:5173
```

- `vite.config.js`：`port: 5173`、`host: 127.0.0.1`、`open: false`
- `.env.development.local`：`VITE_APP_BASE_API = 'http://localhost:8080'`（**跨源绝对地址**，用于验证 CORS/预检，不用同源 `/dev-api`）

## 14.5 DebugCopilot 配置

工作区（`configs/workspace.json`，本机运行配置，不提交）：

```json
{
  "frontendUrl": "http://localhost:5173",
  "backendUrl": "http://localhost:8080",
  "sitUrl": "http://localhost:8081",
  "logfiles": [
    "G:/develop/project/test-targets/ruoyi/logs/sys-info.log",
    "G:/develop/project/test-targets/ruoyi/logs/sys-error.log",
    "G:/develop/project/test-targets/ruoyi/logs-sit/sys-info.log",
    "G:/develop/project/test-targets/ruoyi/logs-sit/sys-error.log"
  ],
  "sourceRoot": "G:/develop/project/test-targets/ruoyi/backend",
  "frontendSourceRoot": "G:/develop/project/test-targets/ruoyi/frontend/src",
  "window": { "beforeMs": 5000, "afterMs": 5000 }
}
```

路由（`configs/routing.json`）：

| 规则 | 前缀 | 目标 |
| --- | --- | --- |
| system-to-sit | `/system` | SIT `http://localhost:8081` |
| local-debug | `/debug/` | 本地 `http://localhost:8080` |
| api-local | `/` | 本地 `http://localhost:8080` |

## 14.6 已验证结果（2026-11-03）

| 场景 | 结果 |
| --- | --- |
| RuoYi 登录（直连） | 200，跳转 `/index` |
| 内嵌浏览器登录 POST | 经本地代理 → 8080，返回 200 + token |
| 用户列表 `/system/user/list` | 经代理 → 8081（SIT），**透传网关 CORS**，200，返回 2 行 |
| Authorization | 浏览器跨源重定向会剥离；已由 CDP 原始请求头恢复后转发 |
| 预检 | 由内置代理 204 应答，后端无需处理 OPTIONS |
| 日志解析 | 新增 `spring-boot` 预设，RuoYi 日志可解析 |
| 诊断 | 捕获请求 + RuoYi 日志 → Mock 诊断 gates ok |
| 日志页签 | 选 `sys-info.log` + `spring-boot` 解析器，按捕获请求对齐查询，返回真实日志记录 |
| DebugCopilot 自身日志 | 开发版写入项目 `logs/debugcopilot.log`（已在 .gitignore） |

## 14.6.1 混合环境场景（真实常态）

页面默认访问**测试环境**，只把正在本地开发的前缀改道到本地：

- 前端 `.env.development.local`：`VITE_APP_BASE_API = 'http://localhost:8081'`（SIT）
- 路由规则：
  - `/login` → local `http://localhost:8080`
  - `/system/user` → local `http://localhost:8080`
  - 其他前缀无规则 → 直接走 SIT 8081（由真实网关处理 CORS）

已验证（2026-11-03）：

| 请求 | 去向 | 结果 |
| --- | --- | --- |
| `POST /login` | 本地 8080（直连改道） | 200 + token |
| `GET /system/user/list` | 本地 8080（直连改道） | 200，2 行 |
| `GET /getInfo` | SIT 8081（直连） | 200 |
| `GET /system/role/list` | SIT 8081（直连） | 200，2 行 |

### 本地服务未启动时

当前实现是**静态按前缀路由**，不自动回退：

- 本地 8080 停掉后，`/login`、`/system/user` 会失败（连接失败），SIT 请求仍正常。
- 需要用户手动停用本地规则或把目标切换为 SIT。
- 若希望“本地不可达自动回退 SIT”，需要新增 health-aware 规则（定期探活 + 不可达时跳过规则），属于候选功能，尚未实现。

## 14.6.2 报错靶子场景

测试页：`http://localhost:5173/debug.html`（需在 DebugCopilot 内嵌浏览器打开）

| 按钮 / 接口 | 预期 | 说明 |
| --- | --- | --- |
| `/debug/ok?orderId=...` | 200 | 正常请求，ERROR 日志基线 |
| `/debug/exception?orderId=...` | 500 | 抛 `IllegalStateException`，error 级堆栈 |
| `/debug/npe?orderId=...` | 500 | NPE 堆栈 |
| `/debug/sql?orderId=...` | 500 | `BadSqlGrammarException`，含错误 SQL |
| `/debug/redis?orderId=...` | 500 | Redis WRONGTYPE 异常 |
| `/debug/business?qty=0` | 409 | 业务错误“库存不足” |
| `/debug/http500?orderId=...` | 500 | 强制 HTTP 500 |
| `/debug/slow?orderId=...` | 200（5s） | 慢请求，日志 start/end |
| `/debug/late-log?orderId=...` | 200 | 3 秒后才写日志，验证时间窗 |
| `/debug/big?orderId=...` | 200 | 500 行 JSON，验证大响应 |
| `/debug-sit/*` | 同上 | 不命中规则，直接走 SIT 8081 |

- `/debug/**` 被路由到本地 8080；`/debug-sit/**` 无规则，走 SIT 8081。
- 两个实例都已关闭 Spring Security 对 `/debug/**`、`/debug-sit/**` 的鉴权，便于直接触发。
- 日志订单号保留在 `orderId`，可直接用于业务 ID 关联验证。

## 14.7 停止与清理

```bash
# 停止 Java（按 PID）
powershell -Command "Stop-Process -Id <pid> -Force"

cd G:/develop/project/test-targets/ruoyi
docker compose down
```

- 数据卷在 `test-targets/ruoyi/data/`，需要重置时删除该目录。
- 日志在 `logs/`（本地）与 `logs-sit/`（SIT）。

## 14.8 注意事项

1. 两个后端共用同一 MySQL/Redis，token 互通；因此 SIT 请求可复用本地登录 token。
2. SIT 日志单独在 `logs-sit/`；当前工作区只配置了本地日志，SIT 请求的诊断证据会偏少，可按需追加。
3. 前端使用绝对 API 地址是为了制造真实跨源；若只想测同源，改回 `/dev-api` 并保持 Vite 代理。
4. Docker Hub 不可直连时使用镜像前缀；MySQL/Redis 版本与 RuoYi 兼容。
5. **中文乱码**：`docker exec -i mysql` 不指定 `--default-character-set=utf8mb4` 时，UTF-8 SQL 会按 latin1 入库，前端显示 `ç³»ç»Ÿ...`。修复：DROP/CREATE 库后按上面命令重导；Java 启动带 `-Dfile.encoding=UTF-8` 可让日志中文正常。
