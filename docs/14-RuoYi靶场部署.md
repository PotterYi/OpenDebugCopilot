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
- `.env.development.local`：`VITE_APP_BASE_API = 'http://localhost:8081'`（**跨源绝对地址**，页面默认走 SIT）

## 14.5 DebugCopilot 配置

工作区（`configs/workspace.json`，本机运行配置，不提交）：

```json
{
  "frontendUrl": "http://localhost:5173",
  "backendUrl": "http://localhost:8080",
  "logfiles": [
    "G:/develop/project/test-targets/ruoyi/logs/sys-info.log",
    "G:/develop/project/test-targets/ruoyi/logs/sys-error.log",
    "G:/develop/project/test-targets/ruoyi/logs-sit/sys-info.log",
    "G:/develop/project/test-targets/ruoyi/logs-sit/sys-error.log"
  ],
  "sourceRoot": "G:/develop/project/test-targets/ruoyi/backend",
  "logParser": "auto",
  "frontendProjectRoot": "G:/develop/project/test-targets/ruoyi/frontend",
  "frontendStartCommand": "npm run dev",
  "verifyCommand": "npm run build:prod",
  "window": { "beforeMs": 5000, "afterMs": 5000 }
}
```

> 通常只需要 `frontendProjectRoot`；`frontendSourceRoot` 是可选项，留空时默认等于项目目录，仅 monorepo / 非标准布局需要填写。
> 启动命令也可留空，按 `pnpm/yarn/npm` 与 `dev → serve → start` 自动选择。左侧「前端服务」可一键启动/重启/停止；关闭 DebugCopilot 时会一并停止由它启动的前端进程。
> 高级配置的「其他后端源码目录」默认不扫描、不修改；只有诊断时勾选「同时扫描其他后端源码」才会授权读取和修复。
> 「诊断日志解析器」默认 auto；如果自动探测降级或手动知道格式，可固定为 logback / spring-boot / pipe 等。

路由（`configs/routing.json`）：

| 规则 | 前缀 | 类型 | 目标 |
| --- | --- | --- | --- |
| local-login | `/login` | local | `http://localhost:8080` |
| local-user | `/system/user` | local | `http://localhost:8080` |
| local-dept | `/system/dept` | local | `http://localhost:8080` |
| （无规则） | 其他 | — | 直接走 SIT 8081 |

> SIT 规则表示**不改道**：`target.kind = "sit"`，`baseUrl` 为空。不要填网关地址——用户本来就在请求网关。
> 旧配置若写成 `kind = "sit"` 且填了 `baseUrl`，装载/保存时会给出告警并可一键改为「改道」；透传规则命中本机请求时也会在运行日志和界面中告警。

## 14.6 已验证结果（2026-11-03）

| 场景 | 结果 |
| --- | --- |
| RuoYi 登录（直连） | 200，跳转 `/index` |
| 内嵌浏览器登录 POST | **直连改道** → 8080，返回 200 + token |
| 用户列表 `/system/user/list` | 直连改道 → 8080，`200/500` 业务错误（fault 注入） |
| `getInfo` / `roleList` | 无规则 → SIT 8081，200 |
| 通知公告 `/system/notice/list` | 无规则 → SIT 8081，`200/500` 业务错误（fault 注入） |
| Authorization | 浏览器跨源重定向会剥离；已由 CDP 原始请求头恢复 |
| 预检 | local 由代理 204 或状态行改写兜底；SIT 不改道、不改头 |
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
- 需要用户手动停用本地规则，或把规则类型切为「SIT」（原样透传，不需要目标地址）。
- 若希望“本地不可达自动回退 SIT”，需要新增 health-aware 规则（定期探活 + 不可达时跳过规则），属于候选功能，尚未实现。

## 14.6.2 业务故障场景（在现有代码里注入）

没有新造测试页面/控制器，而是在 RuoYi 现有服务方法里加入可控故障开关：

`com.ruoyi.common.utils.DebugFaults`（ruoyi-common）读取 JVM 参数 `-Ddebug.faults=a,b,c`。
未开启时完全走原逻辑；开启后对应业务链路抛异常/延迟。

| 开关 | 注入位置 | 现象 |
| --- | --- | --- |
| `loginException` | `SysLoginService.login` | 登录失败，错误堆栈 |
| `loginSlow` | 同上 | 登录延迟 3s |
| `userListSql` | `SysUserServiceImpl.selectUserList` | 用户列表 `BadSqlGrammarException` |
| `userListException` | 同上 | 用户列表业务异常 |
| `deptListException` | `SysDeptServiceImpl.selectDeptList` | 部门树异常 |
| `roleListException` | `SysRoleServiceImpl.selectRoleList` | 角色列表异常 |
| `menuRoutersException` | `SysMenuServiceImpl.selectMenuTreeByUserId` | 登录后菜单路由异常 |
| `noticeListException` | `SysNoticeServiceImpl.selectNoticeList` | 通知公告异常 |

当前实例配置：

```bash
# 本地 8080：用户列表 SQL 错误 + 部门异常
java -Ddebug.faults=userListSql,deptListException -jar ruoyi-admin.jar ...

# SIT 8081：通知公告异常
java -Ddebug.faults=noticeListException -jar ruoyi-admin.jar --server.port=8081 ...
```

配合路由规则：

| 前缀 | 去向 |
| --- | --- |
| `/login` | 本地 8080 |
| `/system/user` | 本地 8080（用户列表报 SQL 错） |
| `/system/dept` | 本地 8080（部门树报错） |
| `/system/role` | 无规则 → SIT 8081（正常） |
| `/system/notice` | 无规则 → SIT 8081（报异常） |

> 若要显式声明 SIT，只填类型、不填目标地址；请求会原样发往它原本要访问的网关。

正常后台页面即可触发：登录 → 用户管理（本地 SQL 错误）→ 部门管理（本地异常）→ 角色管理（SIT 正常）→ 通知公告（SIT 异常）。

> RuoYi 全局异常处理器返回 **HTTP 200 + body `code:500`**。DebugCopilot 会识别该业务错误码，在请求列表显示 `200/500` 并纳入“只显示错误”筛选。

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
2. SIT 日志单独在 `logs-sit/`；当前工作区已同时配置本地与 SIT 日志。
3. 前端使用绝对 API 地址是为了制造真实跨源；若只想测同源，改回 `/dev-api` 并保持 Vite 代理。
4. Docker Hub 不可直连时使用镜像前缀；MySQL/Redis 版本与 RuoYi 兼容。
5. **中文乱码**：`docker exec -i mysql` 不指定 `--default-character-set=utf8mb4` 时，UTF-8 SQL 会按 latin1 入库，前端显示 `ç³»ç»Ÿ...`。修复：DROP/CREATE 库后按上面命令重导；Java 启动带 `-Dfile.encoding=UTF-8` 可让日志中文正常。
